/**
 *       /store/scripts/sendlivedata2abrp.js
 *
 * Module plugin:
 *  Send live data to a better route planner
 *  This version uses the embedded GSM of OVMS, so there's an impact on data consumption
 *  /!\ requires OVMS firmware version 3.2.008-147 minimum (for HTTP call)
 *
 * Enable:
 *  - install at above path
 *  - add to /store/scripts/ovmsmain.js:
 *                 abrp = require('sendlivedata2abrp');
 *  - script reload
 *
 * Usage:
 *  - script eval abrp.info()          => to display vehicle data to be sent to abrp
 *  - script eval abrp.onetime()       => to launch one time the request to abrp server
 *  - script eval abrp.send(1)         => toggle send data to abrp
 *  - script eval abrp.send(0)         => stop sending data
 *  - script eval abrp.resetConfig()   => reset configuration to defaults
 *  - script eval abrp.autoSend(1)     => Automatically start sending telemetry to ABRP when you turn the car on and stop when you turn the car off. You can add this to ovmsmain.js
 *  - script eval abrp.autoSend(0)     => Disable automatically sending telemetry to ABRP when you turn the car on and stop when you turn the car off.
 *
 * Version 2.0 (2020 @biddster)
 *  - Add autoSend
 *  - Code cleanup
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

// These values need to be set using the script console in ovms.js
// Refer to https://docs.openvehicles.com/en/latest/plugin/abrp/README.html#installation
const defaultConfiguration = Object.freeze({
    url: 'http://api.iternio.com/1/tlm/send',
    car_model: '@@:@@:@@:@@:@@',
    user_token: '@@@@@@@@-@@@@-@@@@-@@@@-@@@@@@@@@@@@',
});

const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370';

const topics = Object.freeze({
    VehicleOn: 'vehicle.on',
    VehicleOff: 'vehicle.off',
    Ticker: 'ticker.60',
});

const telemetryChangedIndicators = Object.freeze([
    'soc',
    'soh',
    'lat',
    'lon',
    'alt',
    'is_charging',
    'batt_temp',
    'ext_temp',
]);

var vehicleOnSubscription = null;
var vehicleOffSubscription = null;
var tickerSubscription = null;
var currentTelemetry = null;
var configuration = null;

const handleError = function (error, context) {
    print(context + ' error [' + JSON.stringify(error) + ']\n');
    OvmsNotify.Raise('error', 'usr.abrp.status', context + ' error  - ' + error.message);
};

const loadConfig = function () {
    if (!configuration) {
        configuration = Object.freeze(
            Object.assign({}, defaultConfiguration, OvmsConfig.GetValues('usr', 'abrp.'))
        );
        print('Config ' + JSON.stringify(configuration, null, 4) + '\n');
    }
    return configuration;
};

const unloadConfig = function () {
    // TODO fix this like version 1.x?
    configuration = null;
};

const updateAbrp = function (telemetry) {
    const config = loadConfig();
    // Taken from original sendlivedata2abrp.js
    const url =
        config.url +
        '?api_key=' +
        OVMS_API_KEY +
        '&token=' +
        config.user_token +
        '&tlm=' +
        encodeURIComponent(JSON.stringify(telemetry));

    print('Sending to [' + url + ']\n');

    HTTP.Request({
        url,
        done: function (resp) {
            if (resp.statusCode !== 200) {
                handleError(
                    new Error('Unexpected status code [' + resp.statusCode + ']'),
                    'Http request'
                );
            }
        },
        fail: function (error) {
            handleError(error, 'HTTP request');
        },
    });
};

const getTelemetry = function () {
    const config = loadConfig();
    const state = OvmsMetrics.Value('v.c.state');
    const isCharging = state === 'charging' || state === 'topoff' ? 1 : 0;

    return {
        utc: Math.trunc(Date.now() / 1000),
        soc: Math.floor(Number(OvmsMetrics.Value('v.b.soc'))),
        soh: Number(OvmsMetrics.Value('v.b.soh')),
        speed: Number(OvmsMetrics.Value('v.p.speed')),
        car_model: config.car_model,
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

const isTelemetryValidAndHasChanged = function (previousTelemetry, nextTelemetry) {
    if (nextTelemetry.soh + nextTelemetry.soc === 0) {
        // Taken from original sendlivedata2abrp.js
        // Sometimes the canbus is not readable, and abrp doesn't like 0 values
        print('Telemetry invalid, canbus not readable: reset module and then put motors on\n');
        return false;
    }

    const changed = telemetryChangedIndicators.some(function (indicator) {
        return previousTelemetry[indicator] !== nextTelemetry[indicator];
    });

    print('Telemetry changed [' + changed + ']\n');
    return changed;
};

const sendTelemetry = function (forceAbrpUpdate) {
    try {
        const telemetry = getTelemetry();
        if (
            !currentTelemetry ||
            forceAbrpUpdate ||
            isTelemetryValidAndHasChanged(currentTelemetry, telemetry)
        ) {
            currentTelemetry = telemetry;
            updateAbrp(currentTelemetry);
        }
    } catch (error) {
        handleError(error, 'Send telemetry');
    }
};

const startRoute = function () {
    try {
        unloadConfig();
        sendTelemetry(true);
        if (!tickerSubscription) {
            tickerSubscription = PubSub.subscribe(topics.Ticker, function () {
                sendTelemetry(false);
            });
        }
        print('Starting route - subscribed to ticker\n');
        OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP route started');
    } catch (error) {
        handleError(error, 'Start route');
    }
};

const endRoute = function () {
    try {
        unloadConfig();
        currentTelemetry = null;
        if (tickerSubscription) {
            PubSub.unsubscribe(tickerSubscription);
            tickerSubscription = null;
        }
        print('Ending route - unsubscribed from ticker\n');
        OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP route ended');
    } catch (error) {
        handleError(error, 'End route');
    }
};

exports.onetime = sendTelemetry.bind(null, true);

exports.info = function () {
    unloadConfig();
    print('Telemetry ' + JSON.stringify(getTelemetry(), null, 4));
};

exports.resetConfig = function () {
    OvmsConfig.Delete('usr', 'abrp');
};

exports.send = function (start) {
    if (start) {
        startRoute();
    } else {
        endRoute();
    }
};

exports.autoSend = function (enable) {
    if (enable) {
        if (!vehicleOnSubscription) {
            vehicleOnSubscription = PubSub.subscribe(topics.VehicleOn, function () {
                OvmsNotify.Raise('info', 'usr.abrp.status', 'Vehicle on - starting route');
                startRoute();
            });
            print('Vehicle on subscribed to\n');
        }
        if (!vehicleOffSubscription) {
            vehicleOffSubscription = PubSub.subscribe(topics.VehicleOff, function () {
                OvmsNotify.Raise('info', 'usr.abrp.status', 'Vehicle off - ending route');
                endRoute();
            });
            print('Vehicle off subscribed to\n');
        }
        print('Vehicle on and off topics subscribed\n');
    } else {
        if (vehicleOnSubscription) {
            PubSub.unsubscribe(vehicleOnSubscription);
            vehicleOnSubscription = null;
        }
        if (vehicleOffSubscription) {
            PubSub.unsubscribe(vehicleOffSubscription);
            vehicleOffSubscription = null;
        }
        print('Vehicle on and off topics unsubscribed\n');
    }
};

print('Module loaded');
