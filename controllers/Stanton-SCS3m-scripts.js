"use strict";

// issues:
// - fx mode not mapped, what to put there?
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
    this.timer = engine.beginTimer(40, this.agent.tick);
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
                light: function (bits) {
                    return [NoteOn, id, (bits[0] ? 1 : 0) | (bits[1] ? 2 : 0)]
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
            return {
                one: Touch(either(0x00, 0x01)),
                two: Touch(either(0x02, 0x03)),
                three: Touch(either(0x04, 0x05)),
                four: Touch(either(0x06, 0x07)),
            }
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
    
    function clear() {
        receivers = {};
        slow = [];
        pipe = [];

        // I'd like to disconnect everything on clear, but that doesn't work when using closure callbacks, I guess I'd have to pass the callback function as string name
        // I'd have to invent function names for all handlers
        // Instead I'm not gonna bother and just let the callbacks do nothing
        for (ctrl in watched) {
            if (watched.hasOwnProperty(ctrl)) {
                watched[ctrl] = [];
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
            watched[ctrl] = [];
            engine.connectControl(channel, control, function(value) { 
                var handlers = watched[ctrl];
                var i = 0;
                for(; i < handlers.length; i++) {
                    handlers[i](value);
                }
            });
        }
        
        watched[ctrl].push(handler);

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
    
    function watchmulti(controls, handler) {
        var values = [];
        var wait = controls.length
        var i = 0;
        for (; i < controls.length; i++) {
            (function() {
                var controlpos = i;
                watch(controls[controlpos][0], controls[controlpos][1], function(value) {
                    values[controlpos] = value;
                    if (wait > 1) {
                        wait -= 1;
                    } else {
                        handler(values);
                    }
                });
            })();
        }
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
    
    function reset(channel, control, value) {
        return function() {
            engine.setValue(channel, control, value);
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
    
    var master = Switch(); // Whether master key is held
    var deck = {
        left: Switch(), // off: channel1, on: channel3
        right: Switch() // off: channel2, on: channel4
    }
    var fxon = {
        1: Switch(), 2: Switch(), 3: Switch(), 4: Switch()
    } // off: eq active, on: fx active
    
    var eqheld = {
        left: Switch(),
        right: Switch()
    }
    var fxheld = {
        left: Switch(),
        right: Switch()
    }
    var button1held = {
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

            function either(left, right) { return (side == 'left') ? left : right }

            var channelno = deck[side].choose(either(1,2), either(3,4));
            var channel = '[Channel'+channelno+']';
            var effectchannel = '[QuickEffectRack1_[Channel'+channelno+']]';
            var effectunit = '[EffectRack1_EffectUnit'+channelno+']';
            var effectunit_enable = 'group_'+channel+'_enable';
            var eqsideheld = eqheld[side];
         
            // Switch deck/channel when button is touched
            expect(part.deck.touch, repatch(deck[side].toggle));
            
            // Light the corresponding deck (channel 1: A, channel 2: B, channel 3: C, channel 4: D)
            // Make the lights blink on each beat
            function beatlight(translator, activepos) {
                return function(bits) {
                    bits = bits.slice(); // clone
                    bits[activepos] = !bits[activepos]; // Invert the bit for the light that should be on
                    return translator(bits);
                }
            }
            watchmulti([
                ['[Channel'+either(1,2)+']', 'beat_active'],
                ['[Channel'+either(3,4)+']', 'beat_active'],
            ], patch(beatlight(part.deck.light, deck[side].choose(0,1))));

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
            
            expect(part.eq.high.slide, eqsideheld.choose(
                setgain(channel, 'filterHigh'),
                reset(channel, 'filterHigh', 1)
            ));
            expect(part.eq.mid.slide, eqsideheld.choose(
                setgain(channel, 'filterMid'),
                reset(channel, 'filterMid', 1)
            ));
            expect(part.eq.low.slide, eqsideheld.choose(
                setgain(channel, 'filterLow'),
                reset(channel, 'filterLow', 1)
            ));
            watch(channel, 'filterHigh', gainpatch(offcenter(part.eq.high.meter.centerbar)));
            watch(channel, 'filterMid', gainpatch(offcenter(part.eq.mid.meter.centerbar)));
            watch(channel, 'filterLow', gainpatch(offcenter(part.eq.low.meter.centerbar)));

            expect(part.modes.eq.touch, repatch(both(eqsideheld.engage, fxon[channelno].cancel)));
            expect(part.modes.eq.release, repatch(eqsideheld.cancel));
            tell(part.modes.eq.light[eqsideheld.choose(fxon[channelno].choose('red', 'blue'), 'purple')]);
            
            var button1sideheld = button1held[side];
            var fxsideheld = fxheld[side];
            if (button1sideheld.engaged()) {
                expect(part.modes.fx.touch, toggle(effectunit, effectunit_enable));
            } else {
                expect(part.modes.fx.touch, repatch(both(fxsideheld.engage, fxon[channelno].engage)));
                expect(part.modes.fx.release, repatch(fxsideheld.cancel));
            }
            // Permanently light the FX mode button purple if effect is on
            watch(effectunit, effectunit_enable, binarylight(
                part.modes.fx.light[fxsideheld.choose(fxon[channelno].choose('blue', 'red'), 'purple')],
                part.modes.fx.light.purple
            ));
            
            expect(part.touches.one.touch, repatch(button1sideheld.engage));
            expect(part.touches.one.release, repatch(button1sideheld.cancel));
            tell(part.touches.one.light[button1sideheld.choose('blue', 'purple')]);

            expect(part.touches.two.touch, reset(channel, 'back', 1));
            expect(part.touches.two.release, reset(channel, 'back', 0));
            watch(channel, 'back', binarylight(part.touches.two.light.blue, part.touches.two.light.red));
            expect(part.touches.three.touch, reset(channel, 'fwd', 1));
            expect(part.touches.three.release, reset(channel, 'fwd', 0));
            watch(channel, 'fwd', binarylight(part.touches.three.light.blue, part.touches.three.light.red));
            expect(part.touches.four.touch, toggle(channel, 'play'));
            watch(channel, 'play', binarylight(part.touches.four.light.blue, part.touches.four.light.red));
            
            if (!master.engaged()) {         
                if (button1sideheld.engaged()) {
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
            if (button1sideheld.engaged()) {
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
        
        if (button1held.left.engaged() || button1held.right.engaged()) {
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


