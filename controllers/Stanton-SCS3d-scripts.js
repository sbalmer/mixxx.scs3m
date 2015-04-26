StantonSCS3d = {};

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
    var blue = 0x02;
    var red = 0x01;
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
            return Math.ceil(value * lights);
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
                var center = (lights - 1) / 2 + 1;
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
            bits: function(bits) { return [NoteOn, id, bits]; },
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
        decklight: [
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
    
    // Handlers for received messages
    var receivers = {};
    
    // Connected engine controls
    var watched = {};
    
    function clear() {
        receivers = {};

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

    function setConst(channel, control, value) {
        return function() {
            engine.setParameter(channel, control, value);
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
        function change(state) {
            var prev = engaged;
            engaged = !!state; // Coerce to bool
            return engaged !== prev;
        }
        return {
            'change': function(state) { return change(state); },
            'engage': function() { return change(true); },
            'cancel': function() { return change(false); },
            'toggle': function() { return change(!engaged); },
            'engaged': function() { return engaged; },
            'choose': function(off, on) { return engaged ? on : off; }
        }
    }
    
    function Multiswitch(preset) {
        var engaged = preset;
        function change(state) {
            var prev = engaged;
            engaged = state;
            return engaged !== prev;
        }
        return {
            'engage': function(pos) { return function() { return change(pos); } },
            'engaged': function(pos) { return engaged === pos },
            'active': function() { return engaged; },
            'choose': function(pos, off, on) { return (engaged === pos) ? on : off; }
        }
    }
    
    // mode for each channel
    var mode = {
        1: Multiswitch(vinylpatch),
        2: Multiswitch(vinylpatch),
        3: Multiswitch(vinylpatch),
        4: Multiswitch(vinylpatch)
    };
    
    // left: false
    // right: true
    
    // What side we're on
    var side = Switch();
    
    // What channel is selected on either side
    var activeChannel = [
        Switch(), // Selected channel on the left (1 or 3)
        Switch()  // Selected channel on the right (2 or 4)
    ];
    
    // Glean current channels from control value
    // This part is willfully obtuse and a bad idea
    function gleanChannel(value) {
        // Changed must be set to true if the deck was changed on the current side
        var changed = false;
        
        // check third bit and proceed if it's set
        // otherwise the control is assumed not to carry deck information
        if (value & 0x4) {
            changed = 
                   activeChannel[0].change(value & 0x1) && !side.engaged() // Left side carried in first bit
                || activeChannel[1].change(value & 0x2) && side.engaged(); // Right side in second bit
        }
        return changed;
    }
    
    function repatch(handler) {
        return function(value) {
            var changed = handler(value);
            if (changed) {
                clear();
                patchage();
            }
        }
    }
    
    function fxpatch(channel) {
        tell(device.mode.fx.light.red);
        // Dunno what to do here
    }

    function eqpatch(channel) {
        tell(device.modeset.slider);
        tell(device.mode.eq.light.red);
        watch(channel, 'filterLow', patchleds(device.slider.left.meter.centerbar)); 
        watch(channel, 'filterMid', patchleds(device.slider.middle.meter.centerbar)); 
        watch(channel, 'filterHigh', patchleds(device.slider.right.meter.centerbar));
        
        expect(device.slider.left.slide.abs, set(channel, 'filterLow'));
        expect(device.slider.middle.slide.abs, set(channel, 'filterMid'));
        expect(device.slider.right.slide.abs, set(channel, 'filterHigh'));
    }

    function looppatch() {
        tell(device.mode.loop.light.red);
    }

    function trigpatch() {
        tell(device.mode.trig.light.red);
    }

    function vinylpatch() {
        tell(device.mode.vinyl.light.red);
    }
    
    function patchage() {
        // You win two insanity points if you don't properly misunderstand this
        var channelno = activeChannel[side.choose(0, 1)].choose(side.choose(1, 2), side.choose(3, 4));
        var channel = '[Channel'+channelno+']';
        
        // The logic for the deck light is as follows: Right is red (like with
        // cinch signaling) and the alternative decks are blue.
        //
        //  Deck | Left     | Right
        // -----------------------
        //  Main | 1: black | 2: red
        //  Alt  | 3: blue  | 4: purple
        //
        // If we subtract one from the channelno this maps exactly to the SCS
        // color coding. Don't you marvel at the clean mapping between the two
        // concepts? I started out with this simplistic scheme, decided that it
        // fits well, then made up reasons in favour of it. Laziness be my
        // witness.
        tell(device.mode.deck.light.bits(channelno-1));
        tell(device.decklight[0](!activeChannel[side.choose(0, 1)].engaged()));
        tell(device.decklight[1](activeChannel[side.choose(0, 1)].engaged()));


        tell(device.logo.on);

        expect(device.gain.slide.abs, set(channel, 'volume'));
        watch(channel, 'volume', patchleds(device.gain.meter.bar));

        var activeMode = mode[channelno];
        tell(device.mode.fx.light.blue);
        tell(device.mode.eq.light.blue);
        tell(device.mode.loop.light.blue);
        tell(device.mode.trig.light.blue);
        tell(device.mode.vinyl.light.blue);
        expect(device.mode.fx.touch, repatch(activeMode.engage(fxpatch)));
        expect(device.mode.eq.touch, repatch(activeMode.engage(eqpatch)));
        expect(device.mode.loop.touch, repatch(activeMode.engage(looppatch)));
        expect(device.mode.trig.touch, repatch(activeMode.engage(trigpatch)));
        expect(device.mode.vinyl.touch, repatch(activeMode.engage(vinylpatch)));
        expect(device.mode.deck.touch, repatch(side.toggle));
        
        // Call the patch function that was put into the switch with engage()
        activeMode.active()(channel);
        

        expect(device.button.play.touch, toggle(channel, 'play'));
        watch(channel, 'play', binarylight(device.button.play.light.black, device.button.play.light.red));
        
        expect(device.button.cue.touch, setConst(channel, 'cue_default', true));
        expect(device.button.cue.release, setConst(channel, 'cue_default', false));
        watch(channel, 'cue_default', binarylight(device.button.cue.light.black, device.button.cue.light.red));
        
        expect(device.button.sync.touch, setConst(channel, 'beatsync', true));
        tell(device.button.sync.light.black);
        
        expect(device.button.tap.touch, function() { bpm.tapButton(channelno); });
        watch(channel, 'beat_active', binarylight(device.button.tap.light.black, device.button.tap.light.red));
        
        tell(device.modeset.circle);
        watch(channel, 'playposition', patchleds(function(position) {
            // Duration is not rate-corrected
            var duration = engine.getValue(channel, 'duration');

            // Which means the seconds we get are not rate-corrected either.
            // They tick faster for higher rates.
            var seconds = duration * position;

            // 33⅓rpm = 100 / 3 / 60 rounds/second = 1.8 seconds/round
            var rounds = seconds / 1.8;
            
            // Fractional part is needle's position in the circle
            var needle = rounds % 1;

            return device.slider.circle.meter.needle(1 - needle); // reverse for clockwise
        }));

        // Read deck state from unrelated control which may be set by the 3m
        // Among all the things WRONG about this, two stand out:
        // 1. The control is not meant to transmit this information.
        // 2. A value > 1 is expected from a control which is just a toggle (suggesting a binary value)
        // This may fail at any future or past version of Mixxx and you have only me to blame for it.
        watch('[PreviewDeck1]', 'quantize', repatch(gleanChannel));
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
