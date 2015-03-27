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
    this.timer = engine.beginTimer(10, this.agent.tick);
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
            needle:    function(value) {
                return [CC, id, lights(0, 1, value) ]; 
            },
            centerbar: function(value) {
                return [CC, id, 0x15 + lights(-1, 1, value)]
            },
            bar:       function(value) {
                return [CC, id, 0x28 + lights(0, 0.95, value) ]; 
            }
        }
    }
    
    function Slider(id, width) {
        return {
            meter: Meter(id, width),
            slide: [CC, id],
            mode: {
                absolute: [CM, id, 0x70],
                relative: [CM, id, 0x71]
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
            return Slider(either(0x00, 0x01));
        }
        
        function Eq() {
            return {
                low: Slider(either(0x02, 0x03)),
                mid: Slider(either(0x04, 0x05)),
                high: Slider(either(0x06, 0x07)),
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
            vol: Meter(either(undefined,undefined), 8)
        }
    }
    
    return {
        flat: [0xF0, 0x00, 0x01, 0x60, 0x15, 0x01, 0xF7],
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
    var throttling = false;
    var drops = [];
    var pipe = [];
    
    // Handlers for received messages
    var receivers = {};
    
    // Connected engine controls
    var watched = {};
    
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
        // Silly indirection through registry that keeps all watched controls
        var ctrl = channel + control;

        if (!watched[ctrl]) {
            engine.connectControl(channel, control, function(value) { print(value);watched[ctrl](value); });
        }
        watched[ctrl] = handler;
 
        engine.trigger(channel, control);
    }

    function tell(message) {
        if (throttling) {
            queue.push(message);
            return;
        }
        var address = (message[0] << 8) + message[1];
        
        if (last[address] === message[2]) {
            return; // Not repeating same message
        }

        midi.sendShortMsg(message[0], message[1], message[2]);

        last[address] = message[2];
    }
    
    function tellslowly(message) {
        drops.push(message);
        throttling = true;
    }

    function tick() {
        var message;
        if (drops.length) {
            // drop by drop
            midi.sendShortMsg.apply(midi, drops.shift());
        } else {
            // Open the pipe
            throttling = false;
            while(message = pipe.shift()) {
                tell(message);
            }
        }
    }
    
    // Build a handler that sends messages to the device when it receives engine values
    // translator maps from engine values (interval [-1, 1]) to midi messages (three bytes)
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
            'engage': function() { engaged = true; patchage(); },
            'cancel': function() { engaged = false; patchage(); },
            'toggle': function() { engaged = !engaged; patchage(); },
            'engaged': function() { return engaged; },
            'choose': function(off, on) { return engaged ? on : off; }
        }
    }
    
    var master = Switch(); // Whether master key is held
    var deck = {
        left: Switch(), // off: channel1, on: channel3
        right: Switch() // off: channel2, on: channel4
    }
    
    function patchage() {
        function Side(side) {
            var part = device[side];
            
            // Switch deck/channel when button us released
            expect(part.deck.release, deck[side].toggle);

            tell(part.deck.light[deck[side].choose('first', 'second')]);

            function either(left, right) { return (side == 'left') ? left : right }

            var no = deck[side].choose(either(1,2), either(3,4));
            var channel = '[Channel'+no+']';

            if (master.engaged()) {
                tell(part.gain.mode.relative);
                expect(part.gain.slide, budge(channel, 'pregain'));
                watch(channel, 'pregain', patch(part.gain.meter.needle));
            } else {
                tell(part.gain.mode.absolute);
                expect(part.gain.slide, set(channel, 'volume'));
                watch(channel, 'volume', patch(part.gain.meter.bar));
            }

            watch(channel, 'pfl', binarylight(part.phones.light.blue, part.phones.light.red));
            expect(part.phones.touch, toggle(channel, 'pfl'));
        }

        clear();
        tell(device.logo.on);
        Side('left');
        Side('right');

        tell(device.master.light[master.choose('black', 'purple')]);
        expect(device.master.touch,   master.engage);
        expect(device.master.release, master.cancel);

        expect(device.crossfader.slide, setcenter("[Master]", "crossfader"));
        watch("[Master]", "crossfader", patch(device.crossfader.meter.centerbar));
    }
    
    return {
        start: function() {
            midi.sendSysexMsg(device.flat, device.flat.length);
            patchage();
        },
        tick: tick,
        receive: receive,
        stop: clear
    }
}


