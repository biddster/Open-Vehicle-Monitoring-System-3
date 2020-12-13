/**
 *       /store/scripts/sendlivedata2abrp.js
 *
 * Module plugin:
 *  Send live data to a better route planner
 *  This version uses the embedded GSM of OVMS, so there's an impact on data consumption
 *  /!\ requires OVMS firmware version 3.2.008-147 minimum (for HTTP call)
 *
 * Version 1.3   2020   inf0mike (forum https://www.openvehicles.com)
 *
 * Enable:
 *  - install at above path
 *  - add to /store/scripts/ovmsmain.js:
 *                 abrp = require("sendlivedata2arbp");
 *  - script reload
 *
 * Usage:
 *  - script eval abrp.info()         => to display vehicle data to be sent to abrp
 *  - script eval abrp.onetime()      => to launch one time the request to abrp server
 *  - script eval abrp.send(1)        => toggle send data to abrp
 *  -                      (0)        => stop sending data
 *  - script eval abrp.resetConfig()  => reset configuration to defaults
 *
 * Version 1.3 updates:
 *  - Fix for rounding of fractional SOC causing abrp to report SOC off by 1
 *  - Fix for altitude never being sent
 *  - New convenience method to reset config to defaults
 *
 * Version 1.2 updates:
 *  - based now on OVMS configuration to store user token, car model and url
 *  - review messages sent during charge
 *  - send a message when vehicle is on before moving to update abrp
 *
 * Version 1.1 fix and update:
 *  - fixed the utc refreshing issue
 *  - send notifications
 *  - send live data only if necessary
 **/

/*
 * Declarations:
 *   CAR_MODEL: find your car model here: https://api.iternio.com/1/tlm/get_carmodels_list?api_key=32b2162f-9599-4647-8139-66e9f9528370
 *   OVMS_API_KEY : API_KEY to access to ABRP API, given by the developer
 *   MY_TOKEN : Your token (corresponding to your abrp profile)
 *   TIMER_INTERVAL : to subscribe to a ticker event
 *   URL : url to send telemetry to abrp following: https://iternio.com/index.php/iternio-telemetry-api/
 *   CR : Carriage Return for console prints
 *
 *   objTLM : JSON object containing data read
 *   objTimer : timer object
 */
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370';

const topics = Object.freeze({
    VehicleOn: 'vehicle.on',
    VehicleOff: 'vehicle.off',
    Ticker: 'ticker.60',
});

var vehicleOnSubscription = null;
var vehicleOffSubscription = null;
var tickerSubscription = null;
var currentTelemetry = null;
var config = null;

const loadConfig = function () {
    const values = OvmsConfig.GetValues('usr', 'abrp.');
    if (!config) {
        config = Object.freeze({
            url: values.url,
            userToken: values.user_token,
            carModel: values.car_model,
        });
        print('ABRP::config [' + JSON.stringify(config) + ']\n');
    }
};

const send = function (telemetry) {
    // Taken from original sendlivedata2abrp.js
    const url =
        config.url +
        '?api_key=' +
        OVMS_API_KEY +
        '&token=' +
        config.userToken +
        '&tlm=' +
        encodeURIComponent(JSON.stringify(telemetry));

    print('ABRP::Sending to [' + url + ']\n');

    HTTP.Request({
        url,
        done: function (resp) {
            print('ABRP::HTTP response code [' + resp.statusCode + ']\n');
        },
        fail: function (error) {
            print('ABRP::HTTP request error [' + JSON.stringify(error) + ']\n');
            OvmsNotify.Raise('error', 'usr.abrp.status', JSON.stringify(error));
        },
    });
};

const captureTelemetry = function () {
    const state = OvmsMetrics.Value('v.c.state');
    const isCharging = state === 'charging' || state === 'topoff' ? 1 : 0;

    return {
        utc: Math.trunc(Date.now() / 1000),
        soc: Math.floor(Number(OvmsMetrics.Value('v.b.soc'))),
        soh: Number(OvmsMetrics.Value('v.b.soh')),
        speed: Number(OvmsMetrics.Value('v.p.speed')),
        car_model: 'fixme leaf',
        lat: OvmsMetrics.AsFloat('v.p.latitude').toFixed(3),
        lon: Number(OvmsMetrics.AsFloat('v.p.longitude')).toFixed(3),
        alt: Number(OvmsMetrics.AsFloat('v.p.altitude')).toFixed(1),
        ext_temp: Number(OvmsMetrics.Value('v.e.temp')),
        is_charging: isCharging,
        batt_temp: Number(OvmsMetrics.Value('v.b.temp')),
        voltage: Number(OvmsMetrics.Value('v.b.voltage')),
        current: Number(OvmsMetrics.Value('v.b.current')),
        power: Number(OvmsMetrics.Value('v.b.power')).toFixed(1),
    };
};

const telemetryIsValidAndHasChanged = function (previous, next) {
    if (next.soh + next.soc === 0) {
        // Taken from original sendlivedata2abrp.js
        // Sometimes the canbus is not readable, and abrp doesn't like 0 values
        print(
            'ABRP::Telemetry invalid, canbus not readable: reset module and then put motors on\n'
        );
        return false;
    }
    const keys = ['soc', 'soh', 'lat', 'lon', 'alt', 'is_charging', 'batt_temp', 'ext_temp'];
    for (var i = 0; i < keys.length; ++i) {
        const key = keys[i];
        if (previous[key] != next[key]) {
            print(
                'Telemetry [' +
                    key +
                    '] has changed from [' +
                    previous[key] +
                    '] to [' +
                    next[key] +
                    ']\n'
            );
            return true;
        }
    }
    print('ABRP::Telemetry not changed');
    return false;
};

const sendTelemetry = function (forceUpdate) {
    try {
        loadConfig();
        print('ABRP::Sending telemetry\n');
        const telemetry = captureTelemetry();
        if (
            !currentTelemetry ||
            forceUpdate ||
            telemetryIsValidAndHasChanged(currentTelemetry, telemetry)
        ) {
            currentTelemetry = telemetry;
            send(currentTelemetry);
        }
    } catch (error) {
        print('ABRP::Send telemetry error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.abrp.status',
            'telemetry error - ' + JSON.stringify(error)
        );
    }
};

const onTicker = function () {
    sendTelemetry();
};

const vehicleOn = function () {
    try {
        currentTelemetry = null;
        config = null;
        send('Vehicle turned on');
        tickerSubscription = PubSub.subscribe(topics.Ticker, onTicker);
        print('ABRP::Vehicle turned on - subscribed to interval topic\n');
    } catch (error) {
        print('ABRP::vehicle on error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.abrp.status',
            'vehicle on error - ' + JSON.stringify(error)
        );
    }
};

const vehicleOff = function () {
    try {
        currentTelemetry = null;
        config = null;
        send('Vehicle turned off');
        PubSub.unsubscribe(tickerSubscription);
        tickerSubscription = null;
        print('ABRP::Vehicle turned off - unsubscribed from interval topic\n');
    } catch (error) {
        print('ABRP::vehicle off error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.abrp.status',
            'vehicle off error - ' + JSON.stringify(error)
        );
    }
};

const enableSendBetweenVehicleOnAndOff = function () {
    if (!vehicleOnSubscription) {
        vehicleOnSubscription = PubSub.subscribe(topics.VehicleOn, vehicleOn);
        print('ABRP::Vehicle on subscribed to\n');
    }
    if (!vehicleOffSubscription) {
        vehicleOffSubscription = PubSub.subscribe(topics.VehicleOff, vehicleOff);
        print('ABRP::Vehicle off subscribed to\n');
    }
    print('ABRP::Vehicle on and off topics subscribed\n');
};

const disableSendBetweenVehicleOnAndOff = function () {
    if (vehicleOnSubscription) {
        PubSub.unsubscribe(vehicleOnSubscription);
        vehicleOnSubscription = null;
    }
    if (vehicleOffSubscription) {
        PubSub.unsubscribe(vehicleOffSubscription);
        vehicleOffSubscription = null;
    }
    print('ABRP::Vehicle on and off topics unsubscribed\n');
};

exports.loadConfig = loadConfig;
exports.vehicleOn = vehicleOn;
exports.vehicleOff = vehicleOff;
exports.enableSendBetweenVehicleOnAndOff = enableSendBetweenVehicleOnAndOff;
exports.disableSendBetweenVehicleOnAndOff = disableSendBetweenVehicleOnAndOff;
exports.sendTelemetry = sendTelemetry;
