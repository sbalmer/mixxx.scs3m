StantonSCS3d = {}

StantonSCS3d.init = function(id) {
    this.device = this.Device(0);
    this.agent = this.Agent(this.device);
    this.agent.start();
}

StantonSCS3d.shutdown = function() {
    StantonSCS3d.agent.stop();
}

StantonSCS3d.receive = function(channel, control, value, status) {
    StantonSCS3d.agent.receive(status, control, value);
}

/* MIDI map */
StantonSCS3d.Device = function(channel) {
    var NoteOn = 0x90 + channel;
    var NoteOff = 0x80 + channel;
    var CC = 0xB0 + channel;
    
    var black = 0x00;
    var blue = 0x01;
    var red = 0x02;
    var purple = blue | red;
    
    function Logo() {
        var id = 0x7A;
        return {
            on: [NoteOn, id, 0x01],
            off: [NoteOn, id, 0x00]
        }
    }
    
    function Decklight(id) {
        return function(value) {
            return [NoteOn, id, +value]; // value might be boolean, coerce to int
        };
    }
    
    function Meter(id, lights) {
        // Returns messages that light or extinguish the individual LED
        // of the meter. sel() is called for each light [1..lights]
        // and must return a boolean 
        function bitlights(sel) {
            var msgs = new Array(lights);
            
            // The meter lights are enumerated top-bottom
            // The sel() function gets lowest led = 1, top led = lights
            var i = 0;
            for (; i < lights; i++) {
                msgs[i] = [NoteOn, id+i, +sel(lights-i)];
            }
            return msgs;
        }
        function plain(value) {
            if (value <= 0.0) return 1;
            if (value >= 1.0) return lights;
            return Math.round(value * (lights - 1));
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
                var light = plain(value);
                return bitlights(function(bit) { return light == bit; });
            },
            centerbar: function(value) {
                var center = (lights - 1) / 2;
                var extreme = clamped(value);
                return bitlights(function(bit) { 
                    return (bit >= extreme && bit <= center) || (bit <= extreme && bit >= center);
                });
            },
            bar: function(value) {
                var extreme = zeroclamped(value);
                return bitlights(function(bit) { 
                    return bit <= extreme;
                });
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
    
    function Slider(id, meterid, lights) {
        return {
            meter: Meter(meterid, lights),
            slide: {
                abs: [CC, id],
                rel: [CC, id + 1]
            }
        }
    }
    
    function LightedSlider(id, meterid, lights) {
        var slider = Slider(id, meterid, lights);
        slider.light = Light(meterid-2);
        return slider;
    }
        
    function Touch(id) {
        return {
            light: Light(id),
            touch: [NoteOn, id],
            release: [NoteOff, id]
        }
    }
        
    function Field(id) {
        return {
            touch: [NoteOn, id],
            release: [NoteOff, id]
        }
    }

    return {
        modeset: {
            version: [0xF0, 0x7E, channel, 0x06, 0x01, 0xF7],
            flat: [0xF0, 0x00, 0x01, 0x60, 0x10, 0x00, 0xF7],
            circle: [0xF0, 0x00, 0x01, 0x60, 0x01, 0x00, 0xF7],
            slider: [0xF0, 0x00, 0x01, 0x60, 0x01, 0x03, 0xF7],
            button: [0xF0, 0x00, 0x01, 0x60, 0x01, 0x04, 0xF7]
        },
        logo: Logo(),
        decklights: [
            Decklight(0x71), // A
            Decklight(0x72)  // B
        ],
        gain: LightedSlider(0x07, 0x34, 9),
        pitch: LightedSlider(0x03, 0x3F, 9),
        mode: {
            fx: Touch(0x20),
            loop: Touch(0x22),
            vinyl: Touch(0x24),
            eq: Touch(0x26),
            trig: Touch(0x28),
            deck: Touch(0x2A),
        },
        top: {
            left: Touch(0x2C),
            right: Touch(0x2E)
        },
        slider: {
            circle: Slider(0x62, 0x5d, 16),
            left: Slider(0x0C, 0x48, 7),
            middle: Slider(0x01, 0x56, 7),
            right: Slider(0x0E, 0x4F, 7)
        },
        field: [
            Touch([0x48, 0x4A]),
            Touch([0x48, 0x4A]),
        ],
        bottom: {
            left: Touch(0x30),
            right: Touch(0x32)
        },
        button: {
            play: Touch(0x6D),
            cue: Touch(0x6E),
            sync: Touch(0x6F),
            tap: Touch(0x70),
        }
    }
}


StantonSCS3d.Agent = function(device) {
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
            engine.connectControl(channel, control, function(value, group, control) { 
                var handlers = watched[ctrl];
                if (handlers.length) {
                    // Fetching parameter value is easier than mapping to [0..1] range ourselves
                    value = engine.getParameter(group, control);
                    
                    var i = 0;
                    for(; i < handlers.length; i++) {
                        handlers[i](value);
                    }
                }
            });
        }

        watched[ctrl].push(handler);
        
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
    // Returns whether the massage was sent
    // False is returned if the mesage was sent before.
    function tell(message, force) {
        if (message.length > 3) {
            midi.sendSysexMsg(message, message.length);
            return true;
        }

        var address = (message[0] << 8) + message[1];

        if (!force && last[address] === message[2]) {
            return false; // Not repeating same message
        }

        midi.sendShortMsg(message[0], message[1], message[2]);

        last[address] = message[2];

        return true;
    }
    
    
    // Map engine values in the range [0..1] to lights
    // translator maps from [0..1] to a midi message (three bytes)
    function patch(translator) {
        return function(value) {
            tell(translator(value));
        }
    }  
    
    function patchleds(translator) {
        return function(value) {
            var msgs = translator(value);
            for (i in msgs) {
                if (msgs.hasOwnProperty(i)) tell(msgs[i]);
            }
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
    
    var mode = Multiswitch('vinyl');
    
    function repatch(handler) {
        return function(value) {
            throttling = true;
            handler(value);
            clear();
            patchage();
        }
    }
    
    function patchage() {
        var channel = '[Channel1]'; // sometimes correct

        tell(device.logo.on);

        expect(device.gain.slide.abs, set(channel, 'volume'));
        watch(channel, 'volume', patchleds(device.gain.meter.bar));
    }
    
    return {
        start: function() {
            tell(device.modeset.flat);
            patchage();
        },
        receive: receive,
        stop: function() {
            clear();
            tell(device.lightsoff);
            send(device.logo.on, true);
        }
    }
}
