const topics = Object.freeze({
    VehicleOn: 'vehicle.on',
    VehicleOff: 'vehicle.off',
    Ticker: 'ticker.60',
});

var vehicleOnSubscription = null;
var vehicleOffSubscription = null;
var tickerSubscription = null;

const sendToSlack = function (text) {
    const url = OvmsConfig.Get('usr', 'slack.url');
    print('Sending [' + text + '] to slack [' + url + ']');
    if (!url) {
        print(
            'Slack url must be set in config using [config set usr slack.url https://hooks.slack.com/services/xx/xx/xx]\n'
        );
    }
    const message = {
        username: OvmsConfig.Get('vehicle', 'id'),
        text: text,
    };
    HTTP.Request({
        url: OvmsConfig.GetValues('usr', 'slack.url'),
        post: JSON.stringify(message),
        done: function (resp) {
            print('response code [' + resp.statusCode + ']\n');
        },
    });
};

const isCharging = function () {
    const state = OvmsMetrics.Value('v.c.state');
    if (state === 'charging' || state === 'topoff') {
        return 1;
    }
    return 0;
};

const sendTelemetry = function () {
    print('Sending telemetry\n');
    try {
        const telemetry = {
            utc: Math.trunc(Date.now() / 1000),
            soc: Math.floor(Number(OvmsMetrics.Value('v.b.soc'))),
            soh: Number(OvmsMetrics.Value('v.b.soh')),
            speed: Number(OvmsMetrics.Value('v.p.speed')),
            car_model: 'fixme leaf',
            lat: OvmsMetrics.AsFloat('v.p.latitude').toFixed(3),
            lon: Number(OvmsMetrics.AsFloat('v.p.longitude')).toFixed(3),
            alt: Number(OvmsMetrics.AsFloat('v.p.altitude')).toFixed(1),
            ext_temp: Number(OvmsMetrics.Value('v.e.temp')),
            is_charging: isCharging(),
            batt_temp: Number(OvmsMetrics.Value('v.b.temp')),
            voltage: Number(OvmsMetrics.Value('v.b.voltage')),
            current: Number(OvmsMetrics.Value('v.b.current')),
            power: Number(OvmsMetrics.Value('v.b.power')).toFixed(1),
        };
        const lines = Object.keys(telemetry).map(function (key) {
            return key + '=' + telemetry[key];
        });
        sendToSlack(lines.join('\n'));
    } catch (error) {
        print('send telemetry error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.slack.status',
            'telemetry error - ' + JSON.stringify(error)
        );
    }
};

const vehicleOn = function () {
    try {
        sendToSlack('Vehicle turned on');
        tickerSubscription = PubSub.subscribe(topics.Ticker, sendTelemetry);
        print('Vehicle turned on - subscribed to interval topic\n');
    } catch (error) {
        print('vehicle on error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.slack.status',
            'vehicle on error - ' + JSON.stringify(error)
        );
    }
};

const vehicleOff = function () {
    try {
        sendToSlack('Vehicle turned off');
        PubSub.unsubscribe(tickerSubscription);
        tickerSubscription = null;
        print('Vehicle turned off - unsubscribed from interval topic\n');
    } catch (error) {
        print('vehicle off error [' + JSON.stringify(error) + ']\n');
        OvmsNotify.Raise(
            'error',
            'usr.slack.status',
            'vehicle off error - ' + JSON.stringify(error)
        );
    }
};

exports.enableSendBetweenVehicleOnAndOff = function () {
    if (!vehicleOnSubscription) {
        vehicleOnSubscription = PubSub.subscribe(topics.VehicleOn, vehicleOn);
        print('Vehicle on subscribed to\n');
    }
    if (!vehicleOffSubscription) {
        vehicleOffSubscription = PubSub.subscribe(topics.VehicleOff, vehicleOff);
        print('Vehicle off subscribed to\n');
    }
    print('Vehicle on and off topics subscribed\n');
};

exports.disableSendBetweenVehicleOnAndOff = function () {
    if (vehicleOnSubscription) {
        PubSub.unsubscribe(vehicleOnSubscription);
        vehicleOnSubscription = null;
    }
    if (vehicleOffSubscription) {
        PubSub.unsubscribe(vehicleOffSubscription);
        vehicleOffSubscription = null;
    }
    print('Vehicle on and off topics unsubscribed\n');
};

exports.sendTestMessage = function () {
    sendTelemetry();
};
