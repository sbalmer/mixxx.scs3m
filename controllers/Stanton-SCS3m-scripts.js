"use strict";

// issues:
// - fx mode not mapped, what to put there?
// - filterHigh/Mid/Low is deprecated, what is the replacement? 

// for g in $(seq 0 255); do l=$(printf '%02x\n' $g); for n in $(seq 0 255); do h=$(printf "%02x" $n); echo $h$l; amidi -p hw:1 -S B0${h}${l}; done; done;
// amidi -p hw:1 -S F00001601501F7

StantonSCS3m = {
    timer: false,
    debugging: false
}

StantonSCS3m.init = function(id, debugging) {
    this.debugging = debugging;
    this.device = this.Device(0); // Assuming channel is 0 eh?
    this.agent = this.Agent(this.device);
    this.agent.start();
    this.timer = engine.beginTimer(40, this.agent.tick);
}

StantonSCS3m.shutdown = function() {
    if (StantonSCS3m.timer) engine.stopTimer(StantonSCS3m.timer);
    StantonSCS3m.agent.stop();
}

StantonSCS3m.receive = function(channel, control, value, status) {
    StantonSCS3m.agent.receive(channel|status, control, value)
}

/* midi map */
StantonSCS3m.Device = function(channel) {
    var NoteOn = 0x90 + channel;
    var NoteOff = 0x80 + channel;
    var CC = 0xB0 + channel;
    var CM = 0xBF; /* this is used for slider mode changes (absolute/relative, sending a control change on channel 16!?) */
    
    var black = 0x00;
    var blue = 0x01;
    var red = 0x02;
    var purple = 0x03;
    
    function Logo() {
        var id = 0x69;
        return {
            on: [NoteOn, id, 0x01],
            off: [NoteOn, id, 0x00]
        }
    }
    
    function Meter(id, lights) {
        function plain(value) {
            if (value <= 0.0) return 1;
            if (value >= 1.0) return lights;
            return 1 + Math.round(value * (lights - 1));
        }
        function clamped(value) {
            if (value <= 0.0) return 1;
            if (value >= 1.0) return lights;
            return Math.round(value * (lights - 2) + 1.5);
        }
        function zeroclamped(value) {
            if (value <= 0.0) return 0;
            if (value >= 1.0) return lights;
            return Math.round(value * (lights - 1) + 0.5);
        }
        return {
            needle: function(value) {
                return [CC, id, plain(value)]; 
            },
            centerbar: function(value) {
                return [CC, id, 0x14 + clamped(value)]
            },
            bar: function(value) {
                return [CC, id, 0x28 + zeroclamped(value) ]; 
            }
        }
    }
    
    function Slider(id, lights) {
        return {
            meter: Meter(id, lights),
            slide: [CC, id],
            mode: {
                absolute: [CM, id, 0x70],
                relative: [CM, id, 0x71],
                end:      [CM, id, 0x7F]
            }
        }
    }
        
    function Light(id) {
        return {
            black: [NoteOn, id, black],
            blue: [NoteOn, id, blue],
            red: [NoteOn, id, red],
            purple: [NoteOn, id, purple],
        }
    }
        
    function Touch(id) {
        return {
            light: Light(id),
            touch: [NoteOn, id],
            release: [NoteOff, id]
        }
    }
    
    function Side(side) {
        function either(left, right) {
            return ('left' == side) ? left : right;
        }
        
        function Deck() {
            var id = either(0x10, 0x0F);
            return {
                light: {
                    off: [NoteOn, id, 0],
                    first: [NoteOn, id, 1],
                    second: [NoteOn, id, 2],
                    both: [NoteOn, id, 3]
                },
                touch: [NoteOn, id],
                release: [NoteOff, id]
            }
        }
        
        function Pitch() {
            return Slider(either(0x00, 0x01), 7);
        }
        
        function Eq() {
            return {
                low: Slider(either(0x02, 0x03), 7),
                mid: Slider(either(0x04, 0x05), 7),
                high: Slider(either(0x06, 0x07), 7),
            }
        }
        
        function Modes() {
            return {
                fx: Touch(either(0x0A, 0x0B)),
                eq: Touch(either(0x0C, 0x0D))
            }
        }
        
        function Gain() {
            return Slider(either(0x08, 0x09), 7);
        }
        
        function Touches() {
            return [
                Touch(either(0x00, 0x01)),
                Touch(either(0x02, 0x03)),
                Touch(either(0x04, 0x05)),
                Touch(either(0x06, 0x07)),
            ];
        }
        
        function Phones() {
            return Touch(either(0x08, 0x09));
        }
        
        return {
            deck: Deck(),
            pitch: Pitch(),
            eq: Eq(),
            modes: Modes(),
            gain: Gain(),
            touches: Touches(),
            phones: Phones(),
            meter: Meter(either(0x0C, 0x0D), 7)
        }
    }
    
    return {
        flat: [0xF0, 0x00, 0x01, 0x60, 0x15, 0x01, 0xF7],
        lightsoff: [CC, 0x7B, 0x00],
        logo: Logo(),
        left: Side('left'),
        right: Side('right'),
        master: Touch(0x0E),
        crossfader: Slider(0x0A, 11)
    }
}

StantonSCS3m.Agent = function(device) {
    // Cache last sent bytes to avoid sending duplicates.
    // The second byte of each message (controller id) is used as key to hold
    // the last sent message for each controller.
    var last = {};
    
    // Keeps a queue of commands to perform
    // This is necessary because some messages must be sent with delay lest
    // the device becomes confused
    var loading = true;
    var throttling = false;
    var slow = [];
    var slowterm = [];
    var pipe = [];
    
    // Handlers for received messages
    var receivers = {};
    
    // Connected engine controls
    var watched = {};
    
    // No operation 
    function nop() {};
    
    function clear() {
        receivers = {};
        slow = [];
        pipe = [];

        // I'd like to disconnect everything on clear, but that doesn't work when using closure callbacks, I guess I'd have to pass the callback function as string name
        // I'd have to invent function names for all handlers
        // Instead I'm not gonna bother and just let the callbacks do nothing
        for (ctrl in watched) {
            if (watched.hasOwnProperty(ctrl)) {
                watched[ctrl] = nop;
            }
        }
    }
    
    function receive(type, control, value) {
        var address = (type << 8) + control;

        if (handler = receivers[address]) {
            handler(value);
            return;
        }
    }
    
    function expect(control, handler) {
        var address = (control[0] << 8) + control[1];
        receivers[address] = handler;
    }
    
    function watch(channel, control, handler) {
        // Silly indirection through a registry that keeps all watched controls
        var ctrl = channel + control;

        if (!watched[ctrl]) {
            engine.connectControl(channel, control, function(value) { watched[ctrl](value); });
        }
        watched[ctrl] = handler;
        
        if (loading) {
            // ugly UGLY workaround
            // The device does not light meters again if they haven't changed from last value before resetting flat mode
            // so we tell it some bullshit values which causes awful flicker, luckily only during startup
            // The trigger will then set things straight
            tell(handler(-0.5));
            tell(handler(0.5));
            tell(handler(0));
            tell(handler(1));
        }
        
        engine.trigger(channel, control);

    }
    
    
    // Send MIDI message to device
    // Param message: list of three MIDI bytes
    // Param force: send value regardless of last recorded state
    // Param extra: do not record message as last state
    // Returns whether the massage was sent
    // False is returned if the mesage was sent before.
    function send(message, force, extra) {
        var address = (message[0] << 8) + message[1];
        
        if (!force && last[address] === message[2]) {
            return false; // Not repeating same message
        }

        midi.sendShortMsg(message[0], message[1], message[2]);

        // Record message as sent, unless it as was a mode setting termination message 
        if (!extra) {
            last[address] = message[2];
        }
        return true;
    }

    function tell(message) {
        if (throttling) {
            pipe.push(message);
            return;
        }
        
        send(message);
    }
    
    // Some messages take a while to be digested by the device
    // They are put into the slow queue
    function tellslowly(messages) {
        slow.push(messages);
        throttling = true;
    }
    
    function tick() {
        var message;
        var messages;
        var sent = false;
        
        // Send messages that terminate the previous slow command
        // These need to be sent with delay as well
        if (message = slowterm.shift()) {
            send(message, true, true);
            return;
        }
        
        // Send messages where the device needs a pause after
        while (messages = slow.shift()) {
            // There are usually two messages, one to tell the device
            // what to do, and one to therminate the command
            message = messages.shift();
            
            // Drop by drop
            if (message.length > 3) {
                midi.sendSysexMsg(message, message.length);
                
                // We're done, sysex doesn't have termination command
                return;
            } else {
                sent = send(message);
                
                // Only send termination commands if the command itself was sent
                if (sent) {
                    slowterm = messages;
                    return;
                }
            }
        }

        // And flush
        while (message = pipe.shift()) {
            sent = send(message);

            // Device seems overwhelmed by flurry of messages on init, go easy
            if (loading && sent) return;
        }
        
        // Open the pipe
        throttling = false;

        // WTF is this doing here?
        // This point is reached the first time there were no more messages queued
        // At this point we know we're done loading
        loading = false;
    }
    
    // Map engine values in the range [0..1] to lights
    // translator maps from [0..1] to a midi message (three bytes)
    function patch(translator) {
        return function(value) {
            tell(translator(value));
        }
    }    
    
    // Handle gain values [0..4]
    // Center is 1.0
    // Engine values over 1.0 are overweighted so they reach max lights before engine value reaches 4.0.
    function gainpatch(translator) {
        return function(value) {
            if (value <= 1.0) {
                value = value / 2;
            } else {
                value = 0.5 + (value - 1) / 4
            }
            tell(translator(value));
        }
    }
    
    // Cut off at 0.01
    function vupatch(translator) {
        return function(value) {
            value = value * 1.01 - 0.01;
            tell(translator(value));
        }
    }
    
    // For engine values [-1..1]
    function centerpatch(translator) {
        return function(value) {
            value = (value + 1) / 2;
            tell(translator(value));
        }
    }
    
    // accelerate away from 0.5 so that small changes become visible faster
    function offcenter(translator) {
        return function(value) {
            // If you want to adjust it, fiddle with the exponent (second argument to pow())
            return translator(Math.pow(Math.abs(value - 0.5) * 2, 0.6) / (value < 0.5 ? -2 : 2) + 0.5)
        }
    }
    
    function binarylight(off, on) {
        return function(value) {
            tell(value ? on : off);
        }
    }
    
    function both(h1, h2) {
       return function() {
           h1();
           h2();
       }
    }

    // absolute control
    function set(channel, control) {
        return function(value) {
            engine.setValue(channel, control,
                value/127
            );
        }
    }
    
    function setparam(channel, control) {
        return function(value) {
            engine.setParameter(channel, control,
                value/127
            );
        }
    }

    // absolute centered control
    function setcenter(channel, control) {
        return function(value) {
            engine.setValue(channel, control,
                (value-64)/63
            );
        }
    }
    
    // Gain values in Mixx go from 0 to 4
    function setgain(channel, control) {
        return function(value) {
            var val = value/64;
            if (val > 1) val = 1 + (val - 1) * 3;
            engine.setValue(channel, control, val);
        }
    }
    
    function reset(channel, control) {
        return function() {
            engine.reset(channel, control);
        }
    }

    // relative control
    function budge(channel, control) {
        return function(offset) {
            engine.setValue(channel, control,
                engine.getValue(channel, control)
                + (offset-64)/128
            );
        }
    }
    
    // switch
    function toggle(channel, control) {
        return function() {
            engine.setValue(channel, control,
                !engine.getValue(channel, control)
            );
        }
    }

    function Switch() {
        var engaged = false;
        return {
            'engage': function() { engaged = true; },
            'cancel': function() { engaged = false; },
            'toggle': function() { engaged = !engaged; },
            'engaged': function() { return engaged; },
            'choose': function(off, on) { return engaged ? on : off; }
        }
    }
    
    function Multiswitch(preset) {
        var engaged = preset;
        return {
            'engage': function(pos) { return function() { engaged = pos; }  },
            'cancel': function(pos) { return function() { if (engaged === pos) engaged = preset; } },
            'engaged': function(pos) { return engaged === pos },
            'choose': function(pos, off, on) { return (engaged === pos) ? on : off; }
        }
    }
    
    var master = Switch(); // Whether master key is held
    var deck = {
        left: Switch(), // off: channel1, on: channel3
        right: Switch() // off: channel2, on: channel4
    }

    var overlay = {
        left:  Multiswitch('eq'),
        right: Multiswitch('eq')
    }
    
    var eqheld = {
        left: Switch(),
        right: Switch()
    }
    var fxheld = {
        left: Switch(),
        right: Switch()
    }
    
    function repatch(handler) {
        return function(value) {
            throttling = true;
            handler(value);
            clear();
            patchage();
        }
    }
    
    function patchage() {
        
        function Side(side) {
            var part = device[side];
            
            // Switch deck/channel when button is touched
            expect(part.deck.touch, repatch(deck[side].toggle));
            tell(part.deck.light[deck[side].choose('first', 'second')]);

            function either(left, right) { return (side == 'left') ? left : right }

            var channelno = deck[side].choose(either(1,2), either(3,4));
            var channel = '[Channel'+channelno+']';
            var effectchannel = '[QuickEffectRack1_[Channel'+channelno+']]';
            var eqsideheld = eqheld[side];
            var sideoverlay = overlay[side];

            if (!master.engaged()) {            
                tellslowly([
                    part.pitch.mode.absolute,
                    part.pitch.mode.end
                ]);
                expect(part.pitch.slide, eqsideheld.choose(
                    set(effectchannel, 'super1'),
                    reset(effectchannel, 'super1', 0.5)
                ));
                watch(effectchannel, 'super1', offcenter(patch(part.pitch.meter.centerbar)));
            }
            
            if (sideoverlay.engaged('eq')) {
                expect(part.eq.high.slide, eqsideheld.choose(
                    setgain(channel, 'filterHigh'),
                    reset(channel, 'filterHigh')
                ));
                expect(part.eq.mid.slide, eqsideheld.choose(
                    setgain(channel, 'filterMid'),
                    reset(channel, 'filterMid')
                ));
                expect(part.eq.low.slide, eqsideheld.choose(
                    setgain(channel, 'filterLow'),
                    reset(channel, 'filterLow')
                ));
                watch(channel, 'filterHigh', gainpatch(offcenter(part.eq.high.meter.centerbar)));
                watch(channel, 'filterMid', gainpatch(offcenter(part.eq.mid.meter.centerbar)));
                watch(channel, 'filterLow', gainpatch(offcenter(part.eq.low.meter.centerbar)));
            }

            expect(part.modes.eq.touch, repatch(eqsideheld.engage));
            expect(part.modes.eq.release, repatch(eqsideheld.cancel));
            tell(part.modes.eq.light[eqsideheld.choose(sideoverlay.choose('eq', 'blue', 'red'), 'purple')]);
           
            var fxsideheld = fxheld[side];
            var tnr = 0;
            for (; tnr < 4; tnr++) {
                var touch = part.touches[tnr];
                var fxchannel = channel;
                if (master.engaged()) {
                    fxchannel = either('[Headphone]', '[Master]');
                }
                var effectunit = '[EffectRack1_EffectUnit'+(tnr+1)+']';
                var effectunit_enable = 'group_'+fxchannel+'_enable';
                var effectunit_effect = '[EffectRack1_EffectUnit'+(tnr+1)+'_Effect1]';
                
                if (fxsideheld.engaged() || master.engaged()) {
                    expect(touch.touch, toggle(effectunit, effectunit_enable));
                } else {
                    expect(touch.touch, repatch(sideoverlay.engage(tnr)));
                }
                expect(touch.release, repatch(sideoverlay.cancel(tnr)));
                watch(effectunit, effectunit_enable, binarylight(touch.light.blue, touch.light.red));

                if (sideoverlay.engaged(tnr)) {
                    expect(part.eq.high.slide, eqsideheld.choose(
                        setparam(effectunit_effect, 'parameter3'),
                        reset(effectunit_effect, 'parameter3')
                    ));
                    expect(part.eq.mid.slide, eqsideheld.choose(
                        setparam(effectunit_effect, 'parameter2'),
                        reset(effectunit_effect, 'parameter2')
                    ));
                    expect(part.eq.low.slide, eqsideheld.choose(
                        setparam(effectunit_effect, 'parameter1'),
                        reset(effectunit_effect, 'parameter1')
                    ));
                    watch(effectunit_effect, 'parameter3', patch(part.eq.high.meter.needle));
                    watch(effectunit_effect, 'parameter2', patch(part.eq.mid.meter.needle));
                    watch(effectunit_effect, 'parameter1', patch(part.eq.low.meter.needle));
                }
            }
            
            expect(part.modes.fx.touch, repatch(fxsideheld.engage));
            expect(part.modes.fx.release, repatch(fxsideheld.cancel));
            tell(part.modes.fx.light[fxsideheld.choose('blue', 'purple')]);
          
            if (!master.engaged()) {         
                if (fxsideheld.engaged()) {
                    tellslowly([
                        part.gain.mode.relative,
                        part.gain.mode.end
                    ]);
                    expect(part.gain.slide, budge(channel, 'pregain'));
                    watch(channel, 'pregain', gainpatch(offcenter(part.gain.meter.needle)));
                } else {
                    tellslowly([
                        part.gain.mode.absolute,
                        part.gain.mode.end
                    ]);
                    expect(part.gain.slide, set(channel, 'volume'));
                    watch(channel, 'volume', patch(part.gain.meter.bar));
                }
            }

            watch(channel, 'pfl', binarylight(part.phones.light.blue, part.phones.light.red));
            expect(part.phones.touch, toggle(channel, 'pfl'));
            
            // Needledrop into track
            if (fxsideheld.engaged()) {
                expect(device.crossfader.slide, set(channel, "playposition"));
                tell(device.crossfader.meter.bar(0));
                watch(channel, "playposition", patch(device.crossfader.meter.needle));
            }
            if (!master.engaged()) {
                watch(channel, 'VuMeter', vupatch(part.meter.bar));
            }
        }

        // Light the logo and let it go out to signal an overload
        watch("[Master]", 'audio_latency_overload', binarylight(
            device.logo.on,
            device.logo.off
        ));
        
        Side('left');
        Side('right');

        tell(device.master.light[master.choose('blue', 'purple')]);
        expect(device.master.touch,   repatch(master.engage));
        expect(device.master.release, repatch(master.cancel));
        if (master.engaged()) {
            watch("[Master]", "headMix", centerpatch(device.left.pitch.meter.centerbar));
            expect(device.left.pitch.slide, 
                eqheld.left.engaged() || fxheld.left.engaged()
                ? reset('[Master]', 'headMix', -1)
                : setcenter('[Master]', 'headMix')
            );
            
            watch("[Master]", "balance", centerpatch(device.right.pitch.meter.centerbar));
            expect(device.right.pitch.slide, 
                eqheld.right.engaged() || fxheld.right.engaged()
                ? reset('[Master]', 'balance', 0)
                : setcenter('[Master]', 'balance')
            );
            
            tellslowly([
                device.left.gain.mode.relative,
                device.left.gain.mode.end
            ]);
            watch("[Master]", "headVolume", gainpatch(device.left.gain.meter.centerbar));
            expect(device.left.gain.slide, budge('[Master]', 'headVolume'));
            
            tellslowly([
                device.right.gain.mode.relative,
                device.right.gain.mode.end
            ]);
            watch("[Master]", "volume", gainpatch(device.right.gain.meter.centerbar));
            expect(device.right.gain.slide, budge('[Master]', 'volume'));
            
            watch("[Master]", "VuMeterL", vupatch(device.left.meter.bar));
            watch("[Master]", "VuMeterR", vupatch(device.right.meter.bar));
        }
        
        if (fxheld.left.engaged() || fxheld.right.engaged()) {
            // Handled in Side()
        } else {
            expect(device.crossfader.slide, setcenter("[Master]", "crossfader"));
            watch("[Master]", "crossfader", centerpatch(device.crossfader.meter.centerbar));
        }
    }
    
    return {
        start: function() {
            loading = true;
            tellslowly([device.flat]);
            patchage();
        },
        tick: tick,
        receive: receive,
        stop: function() {
            clear();
            tell(device.lightsoff);
            send(device.logo.on, true);
        }
    }
}


