"use strict";

// issues:
// - filterHigh/Mid/Low is deprecated, what is the replacement? 

// manually test messages
// amidi -p hw:1 -S F00001601501F7 # flat mode
// amidi -p hw:1 -S 900302 # 90: note on, 03: id of a touch button, 02: red LED

StantonSCS3m = {
    timer: false
}

StantonSCS3m.init = function(id) {
    this.device = this.Device();
    this.agent = this.Agent(this.device);
    this.agent.start();
    this.timer = engine.beginTimer(20, this.agent.tick);
}

StantonSCS3m.shutdown = function() {
    if (StantonSCS3m.timer) engine.stopTimer(StantonSCS3m.timer);
    StantonSCS3m.agent.stop();
}

StantonSCS3m.receive = function(channel, control, value, status) {
    StantonSCS3m.agent.receive(status, control, value)
}

/* midi map */
StantonSCS3m.Device = function() {
    var NoteOn = 0x90;
    var NoteOff = 0x80;
    var CC = 0xB0;
    var CM = 0xBF; /* this is used for slider mode changes (absolute/relative, sending a control change on channel 16!?) */
    
    var black = 0x00;
    var blue = 0x01;
    var red = 0x02;
    var purple = blue | red;
    
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
        factory: [0xF0, 0x00, 0x01, 0x60, 0x40, 0xF7],
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
    var throttling = true;
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
            engine.connectControl(channel, control, function(value, group, control) {
                if (watched[ctrl]) {
                    // Fetching parameter value is easier than mapping to [0..1] range ourselves
                    value = engine.getParameter(group, control);
                    watched[ctrl](value); 
                }
            });
        }
        watched[ctrl] = handler;
        
        if (loading) {
            // ugly UGLY workaround
            // The device does not light meters again if they haven't changed from last value before resetting flat mode
            // so we send each control some bullshit values which causes awful flicker during startup
            // The trigger will then set things straight
            tell(handler(100));
            tell(handler(-100));
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
            // what to do, and one to terminate the command
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
        
        while (pipe.length) {
            message = pipe.shift();
            sent = message && send(message); // Bug: There are undefined values in the queue, ignoring them

            // Device seems overwhelmed by flurry of messages on init, go easy
            if (loading && sent) return;
        }

        // Open the pipe
        throttling = false;
        loading = false;
    }
    
    // Map engine values in the range [0..1] to lights
    // translator maps from [0..1] to a midi message (three bytes)
    function patch(translator) {
        return function(value) {
            tell(translator(value));
        }
    }    
    
    // Cut off at 0.01 because it drops off very slowly
    function vupatch(translator) {
        return function(value) {
            value = value * 1.01 - 0.01;
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

    // absolute control
    function set(channel, control) {
        return function(value) {
            engine.setParameter(channel, control,
                value/127
            );
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
                if (sideoverlay.engaged('eq')) {
                    expect(part.pitch.slide, eqsideheld.choose(
                        set(effectchannel, 'super1'),
                        reset(effectchannel, 'super1')
                    ));
                    watch(effectchannel, 'super1', offcenter(patch(part.pitch.meter.centerbar)));
                }
            }
            
            if (sideoverlay.engaged('eq')) {
                expect(part.eq.high.slide, eqsideheld.choose(
                    set(channel, 'filterHigh'),
                    reset(channel, 'filterHigh', 1)
                ));
                expect(part.eq.mid.slide, eqsideheld.choose(
                    set(channel, 'filterMid'),
                    reset(channel, 'filterMid', 1)
                ));
                expect(part.eq.low.slide, eqsideheld.choose(
                    set(channel, 'filterLow'),
                    reset(channel, 'filterLow', 1)
                ));
                watch(channel, 'filterHigh',patch(offcenter(part.eq.high.meter.centerbar)));
                watch(channel, 'filterMid', patch(offcenter(part.eq.mid.meter.centerbar)));
                watch(channel, 'filterLow', patch(offcenter(part.eq.low.meter.centerbar)));
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
                if (sideoverlay.engaged(tnr)) {
                    tell(touch.light.purple);
                } else {
                    watch(effectunit, effectunit_enable, binarylight(touch.light.blue, touch.light.red));
                }
                
                if (sideoverlay.engaged(tnr)) {
                    expect(part.pitch.slide, eqsideheld.choose(
                        set(effectunit, 'mix'),
                        reset(effectunit, 'mix')
                    ));
                    watch(effectunit, 'mix', patch(part.pitch.meter.bar));

                    expect(part.eq.high.slide, eqsideheld.choose(
                        set(effectunit_effect, 'parameter3'),
                        reset(effectunit_effect, 'parameter3')
                    ));
                    expect(part.eq.mid.slide, eqsideheld.choose(
                        set(effectunit_effect, 'parameter2'),
                        reset(effectunit_effect, 'parameter2')
                    ));
                    expect(part.eq.low.slide, eqsideheld.choose(
                        set(effectunit_effect, 'parameter1'),
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
                    watch(channel, 'pregain', patch(offcenter(part.gain.meter.needle)));
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
            watch("[Master]", "headMix", patch(device.left.pitch.meter.centerbar));
            expect(device.left.pitch.slide, 
                eqheld.left.engaged() || fxheld.left.engaged()
                ? reset('[Master]', 'headMix', -1)
                : set('[Master]', 'headMix')
            );
            
            watch("[Master]", "balance", patch(device.right.pitch.meter.centerbar));
            expect(device.right.pitch.slide, 
                eqheld.right.engaged() || fxheld.right.engaged()
                ? reset('[Master]', 'balance', 0)
                : set('[Master]', 'balance')
            );
            
            tellslowly([
                device.left.gain.mode.relative,
                device.left.gain.mode.end
            ]);
            watch("[Master]", "headVolume", patch(device.left.gain.meter.centerbar));
            expect(device.left.gain.slide, budge('[Master]', 'headVolume'));
            
            tellslowly([
                device.right.gain.mode.relative,
                device.right.gain.mode.end
            ]);
            watch("[Master]", "volume", patch(device.right.gain.meter.centerbar));
            expect(device.right.gain.slide, budge('[Master]', 'volume'));
            
            watch("[Master]", "VuMeterL", vupatch(device.left.meter.bar));
            watch("[Master]", "VuMeterR", vupatch(device.right.meter.bar));
        }
        
        if (fxheld.left.engaged() || fxheld.right.engaged()) {
            // Handled in Side()
        } else {
            expect(device.crossfader.slide, set("[Master]", "crossfader"));
            watch("[Master]", "crossfader", patch(device.crossfader.meter.centerbar));
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


