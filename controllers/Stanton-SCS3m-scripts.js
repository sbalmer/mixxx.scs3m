"use strict";

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
    this.timer = engine.beginTimer(30, this.agent.tick);
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
    
    function Meter(id, width) {
        function lights(min, max, value) {
            if (value <= min) return 0;
            if (value >= max) return width;
            return Math.max(1, Math.min(width-1, Math.round((value - min) / (max - min) * width)))
        }

        return {
            gainneedle: function(value) {
                return [CC, id, lights(0.5, 1.5, value) ]; 
            },
            needle: function(value) {
                return [CC, id, lights(0, 1, value) ]; 
            },
            centerbar: function(value) {
                return [CC, id, 0x15 + lights(-1, 1, value)]
            },
            halfcenterbar: function(value) {
                return [CC, id, 0x15 + lights(0, 1, value)]
            },
            centergainbar: function(value) {
                return [CC, id, 0x15 + lights(0, 2, value)]
            },
            bar: function(value) {
                return [CC, id, 0x28 + lights(0, 0.95, value) ]; 
            },
            vubar: function(value) {
                return [CC, id, 0x28 + lights(0.01, 1, value) ]; 
            }
        }
    }
    
    function Slider(id, width) {
        return {
            meter: Meter(id, width),
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
            return Slider(either(0x00, 0x01), 6);
        }
        
        function Eq() {
            return {
                low: Slider(either(0x02, 0x03), 6),
                mid: Slider(either(0x04, 0x05), 6),
                high: Slider(either(0x06, 0x07), 6),
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
        crossfader: Slider(0x0A, 10)
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
        drops = [];
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
        var address = type << 8 + control;

        if (handler = receivers[address]) {
            handler(value);
            return;
        }
    }
    
    function expect(control, handler) {
        var address = control[0] << 8 + control[1];
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
            tell(watched[ctrl](-0.5));
            tell(watched[ctrl](0.5));
            tell(watched[ctrl](0));
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
        var sent = false;
        
        // Send messages that terminate the previous slow command
        // These need to be sent with delay as well
        while (!sent && (message = slowterm.shift())) {
            send(message, true, true);
            sent = true;
        }
        
        // Send messages where the device needs a pause after
        while (!sent && (messages = slow.shift())) {
            message = messages.shift();
            
            // Drop by drop
            if (message.length > 3) {
                midi.sendSysexMsg(message, message.length);
                sent = true;
            } else {
                sent = send(message);
                
                // Only send termination commands if the command itself was sent
                if (sent) {
                    slowterm = messages;
                }
            }
        }

        if (!sent) {
            // And flush
            while (message = pipe.shift()) {
                sent = send(message);

                // Device seems overwhelmed by flurry of messages on init, go easy
                if (loading && sent) return;
            }
            
            // Open the pipe
            throttling = false;
           if (loading) print('done loading'); 
            // WTF is this doing here?
            // This point is reached the first time there were no more messages queued
            // At this point we know we're done loading
            loading = false;
        }
    }
    
    // Build a handler that sends messages to the device when it receives engine values
    // translator maps from engine values to midi messages (three bytes)
    function patch(translator) {
        return function(value) {
            tell(translator(value));
        }
    }
    
    function binarylight(off, on) {
        return function(value) {
            if (value) tell(on);
            else tell(off);
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
                value/128
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
    
    // Gain values in Mixx go from 0 to 
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
            
            tellslowly([
                part.pitch.mode.absolute,
                part.pitch.mode.end
            ]);
            expect(part.pitch.slide, eqsideheld.choose(
                set(effectchannel, 'super1'),
                reset(effectchannel, 'super1', 0.5)
            ));
            watch(effectchannel, 'super1', patch(part.pitch.meter.halfcenterbar));
            
            
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
            watch(channel, 'filterHigh', patch(part.eq.high.meter.centergainbar));
            watch(channel, 'filterMid', patch(part.eq.mid.meter.centergainbar));
            watch(channel, 'filterLow', patch(part.eq.low.meter.centergainbar));

            expect(part.modes.eq.touch, repatch(both(eqsideheld.engage, fxon[channelno].cancel)));
            expect(part.modes.eq.release, repatch(eqsideheld.cancel));
            tell(part.modes.eq.light[eqsideheld.choose(fxon[channelno].choose('red', 'blue'), 'purple')]);
            
            var fxsideheld = fxheld[side];
            expect(part.modes.fx.touch, repatch(both(fxsideheld.engage, fxon[channelno].engage)));
            expect(part.modes.fx.release, repatch(fxsideheld.cancel));
            tell(part.modes.fx.light[fxsideheld.choose(fxon[channelno].choose('blue', 'red'), 'purple')]);
            
            if (master.engaged()) {
                tellslowly([
                    part.gain.mode.relative,
                    part.gain.mode.end
                ]);
                expect(part.gain.slide, budge(channel, 'pregain'));
                watch(channel, 'pregain', patch(part.gain.meter.gainneedle));
            } else {
                tellslowly([
                    part.gain.mode.absolute,
                    part.gain.mode.end
                ]);
                expect(part.gain.slide, set(channel, 'volume'));
                watch(channel, 'volume', patch(part.gain.meter.bar));
            }

            watch(channel, 'pfl', binarylight(part.phones.light.blue, part.phones.light.red));
            expect(part.phones.touch, toggle(channel, 'pfl'));
            
            watch(channel, 'VuMeter', patch(part.meter.vubar));
        }

        tell(device.logo.on);
        Side('left');
        Side('right');

        tell(device.master.light[master.choose('blue', 'purple')]);
        expect(device.master.touch,   repatch(master.engage));
        expect(device.master.release, repatch(master.cancel));

        expect(device.crossfader.slide, setcenter("[Master]", "crossfader"));
        watch("[Master]", "crossfader", patch(device.crossfader.meter.centerbar));
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


