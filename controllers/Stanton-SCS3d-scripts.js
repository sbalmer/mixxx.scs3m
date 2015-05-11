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
        var ctrl = [];
        var i = 0;
        for (; i < lights; i++) {
            ctrl[i] = [NoteOn, id+lights-i-1];
        }
        return ctrl;
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

    function Touch(id, lightid) {
        if (!lightid) lightid = id;
        return {
            light: Light(lightid),
            touch: [NoteOn, id],
            release: [NoteOff, id]
        }
    }


    // Stanton changed button mode in newer devices.
    // Originally, in button mode, the three columns held 4 "buttons"
    // each. Hitting one of those without accidentally touching another requires 
    // very accurate motor control beyond the capabilities of a DJ (even when 
    // sober). Later versions of the device send only two buttons per column
    // (top/bottom), these are easy to hit.
    //
    // So not only do we need two id to map to the same field, we want to control
    // multiple lights for this control as well. This is why we're using the plural 
    // here. The respective functions expect() and tell() know about this.
    function Field(ids, lightids) {
        return {
            touch: [NoteOn, ids],
            release: [NoteOff, ids],
            light: Light(lightids)
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
            Touch([0x48, 0x4A], [0x61, 0x62]),
            Touch([0x4C, 0x4E], [0x5F, 0x60]),
            Touch([0x4F, 0x51], [0x67, 0x68]),
            Touch([0x53, 0x55], [0x69, 0x6A]),
            Touch(0x01, [0x64, 0x65, 0x5D, 0x6C])
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

// debugging helper
var printmess = function(message, text) {
    var i;
    var s = '';

    for (i in message) {
        s = s + ('0' + message[i].toString(16)).slice(-2)
    }
    print("Midi "+s+(text?' '+text:''));
};



StantonSCS3d.Comm = function() {
    // Build a control identifier (CID) from the first two message bytes.
    function CID(message) {
        return (message[0] << 8) + message[1];
    }

    // Static state of the LED, indexed by CID
    // This keeps the desired state before modifiers, so that adding
    // or removing modifiers is possible without knowing the base state.
    var base = {};
    
    // Modifier functions over base, indexed by CID
    // The functions receive the last byte of the message and return the
    // modified value. They don't 
    var mask = {};
    
    // List of masks that depend on time
    var ticking = {};
    
    // CID that may need updating
    var dirty = {};
    
    // Last sent messages, indexed by CID
    var actual = {};
    
    // Tick counter
    var ticks = 0;
    
    // Handler functions indexed by CID
    var receivers = {};
    
    // List of handlers for control changes from the engine
    var watched = {};
    
    function send() {
        for (cid in dirty) {
            var message = base[cid];
            if (!message) continue; // As long as no base is set, don't send anything
            
            var last = actual[cid];
            if (message.length > 3) {
                // Sysex messages are expected to be modesetting messages
                // They are expected to differ in the second last byte
                if (
                    last
                 || last != message[message.length-2]
                ) {
                    midi.sendSysexMsg(message, message.length);
                    actual[cid] = message[message.length-2];
                }
            } else {
                var value = message[2];
                if (mask[cid]) {
                    value = mask[cid](value, ticks);
                } else {
                }
                if (last === undefined || last != value) {
                    midi.sendShortMsg(message[0], message[1], value);
                    actual[cid] = value;
                }
            }
        }
        dirty = {};
    }
    
    return {
        base: function(message, force) {
            var cid = CID(message);

            base[cid] = message;
            dirty[cid] = true;

            if (force) {
                delete actual[cid];
            }
        },
    
        mask: function(message, mod, changes) {
            var cid = CID(message);
            mask[cid] = mod;
            dirty[cid] = true;
        },
        
        unmask: function(message) {
            var cid = CID(message);
            if (mask[cid]) {
                delete mask[cid];
                dirty[cid] = true;
            }
        },
    
        tick: function() {
            for (cid in ticking) {
                dirty[cid] = true;
            }
            send();
            ticks += 1;
        },
        
        clear: function() {
            receivers = {};
            ticking = {};
            for (cid in mask) {
                dirty[cid] = true;
            }
            mask = {};
            // base and actual are not cleared
            
            
            // I'd like to disconnect all controls on clear, but that doesn't
            // work when using closure callbacks. So we just don't listen to 
            // those
            for (ctrl in watched) {
                if (watched.hasOwnProperty(ctrl)) {
                    watched[ctrl] = [];
                }
            }
        },
        
        expect: function(message, handler) {
            var cid = CID(message);
            receivers[cid] = handler;
        },
        
        receive: function(type, control, value) {
            var cid = CID([type, control]);
            var handler = receivers[cid];
            if (handler) {
                handler(value);
                send();
            }
        },
        
        watch: function(channel, control, handler) {
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
                        send();
                    }
                });
            }

            watched[ctrl].push(handler);
            
            engine.trigger(channel, control);
        }
    };
}


// Create a function that sets the rate of each channel by the timing between
// calls
StantonSCS3d.Syncopath = function() {
    // Lists of last ten taps, per deck, in epoch milliseconds
    var deckTaps = {};

    return function(channel) {
        var now = new Date().getTime();
        var taps = deckTaps[channel] || [];

        var last = taps[0] || 0;
        var delta = now - last;

        // Reset when taps are stale
        if (delta > 2000) {
            deckTaps[channel] = [now];
            return;
        }
        
        taps.unshift(now);
        taps = taps.slice(0, 8); // Keep last eight
        deckTaps[channel] = taps;
        
        //  Don't set rate until we have enough taps
        if (taps.length < 3) return;
        
        // Calculate average bpm
        var intervals = taps.length - 1;
        var beatLength = (taps[0] - taps[intervals]) / intervals;
        var bpm = 60000 / beatLength; // millis to 1/minutes
        
        // The desired pitch rate depends on the BPM of the track
        var rate = bpm / engine.getValue(channel, "file_bpm");

        // Balk on outlandish rates
        if (isNaN(rate) || rate < 0.05 || rate > 50) return;
        
        // Translate rate into pitch slider position
        // This depends on the configured range of the slider
        var pitchPos = (rate - 1) / engine.getValue(channel, "rateRange");
        
        engine.setValue(channel, "rate", pitchPos);
    };
}


StantonSCS3d.Agent = function(device) {

    // Multiple controller ID may be specified in the MIDI messages used
    // internally. The output functions will demux and run the same action on
    // both messages.
    //
    // demux(function(message) { print message; })(['hello', ['me', 'you']])
    // -> hello,me
    // -> hello,you
    function demux(action) {
        return function(message, nd) {
            var changed = false;
            if (message[1].length) {
                var i;
                for (i in message[1]) {
                    var demuxd = [message[0], message[1][i], message[2]];
                    changed = action(demuxd, nd) || changed;
                }
            } else {
                changed = action(message, nd);
            }
            return changed;
        }
    }
    
    var comm = StantonSCS3d.Comm();
    var taps = StantonSCS3d.Syncopath();

    function expect(control, handler) {
        demux(function(control) {
            comm.expect(control, handler);
        })(control);
    }

    function watch(channel, control, handler) {
        comm.watch(channel, control, handler);
    }
    
    function watchmulti(controls, handler) {
        var values = {};
        var wait = 0;
        for (k in controls) {
            wait += 1;
            (function() {
                var valuePos = k;
                watch(controls[k][0], controls[k][1], function(value) {
                    values[valuePos] = value;
                    
                    // Call handler once all values are collected
                    // The simplistic wait countdown works because watch()
                    // triggers all controls and they answer in series
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
    var tell = demux(function(message, force) {
        comm.base(message, force);
    });

    // Map engine values in the range [0..1] to lights
    // translator maps from [0..1] to a midi message (three bytes)
    function patch(translator) {
        return function(value) {
            tell(translator(value));
        }
    }
    
    // Patch multiple
    function patchleds(translator) {
        return function(value) {
            var msgs = translator(value);
            for (i in msgs) {
                if (msgs.hasOwnProperty(i)) tell(msgs[i]);
            }
        }
    }
    
    function binarylight(off, on) {
        return function(value) {
            tell(value ? on : off);
        }
    }
    
    // Return a handler that lights one LED depending on value
    function Needle(lights) {
        var range = lights.length - 1;
        return function(value) {
            // Where's the needle?
            // On the first light for zero values, on the last for one.
            var pos = Math.max(0, Math.min(range, Math.round(value * range)));
            var i = 0;
            for (; i <= range; i++) {
                var light = lights[i];
                tell([light[0], light[1], i == pos]);
            }
        }
    }
    
    // Return a handler that lights LED from the center of the meter
    function Centerbar(lights) {
        var count = lights.length;
        var range = count - 1;
        var center = Math.round(count / 2) - 1; // Zero-based
        return function(value) {
            var pos = Math.max(0, Math.min(range, Math.round(value * range)));
            var left = Math.min(center, pos);
            var right = Math.max(center, pos);
            var i = 0;
            for (; i < count; i++) {
                var light = lights[i];
                tell([light[0], light[1], i >= left && i <= right]);
            }
        }
    }
    
    // Return a handler that lights LED from the bottom of the meter
    // For zero values no light is turned on
    function Bar(lights) {
        var count = lights.length;
        var range = count - 1;
        return function(value) {
            var pos;
            if (value == 0) {
                pos = -1; // no light
            } else {
                pos = Math.max(0, Math.min(range, Math.round(value * range)));
            }
            var i = 0;
            for (; i < lights.length; i++) {
                var light = lights[i];
                tell([light[0], light[1], i <= pos]);
            }
        }
    }
    
    // Show a spinning light in remembrance of analog technology
    function spinLight(channel, warnDuration) {
        watchmulti({
            'position': [channel, 'playposition'],
            'duration': [channel, 'duration'],
            'play':     [channel, 'play'],
            'rate':     [channel, 'rate'],
            'range':    [channel, 'rateRange']
        }, function(values) {
            // Duration is not rate-corrected
            var duration = values.duration;

            // Which means the seconds we get are not rate-corrected either.
            // They tick faster for higher rates.
            var seconds = duration * values.position;

            // 33⅓rpm = 100 / 3 / 60 rounds/second = 1.8 seconds/round
            var rounds = seconds / 1.8;
            
            // Fractional part is needle's position in the circle
            var needle = rounds % 1;

            var lights = device.slider.circle.meter;
            var count = lights.length;
            var pos = count - Math.floor(needle * count) - 1; // Zero-based index

            // Add a warning indicator for the last seconds of a song
            var left = duration - seconds;
            
            // Because the seconds are not rate-corrected, we must scale
            // warnDuration according to pitch rate.
            var scaledWarnDuration = warnDuration + warnDuration * ((values.rate - 0.5) * 2 * values.range);

            var warnPos = false;
            if (left < scaledWarnDuration) {
                // Add a blinking light that runs a tad slower so the needle
                // will reach it when the track runs out
                var warnLight = (needle + (left / scaledWarnDuration)) % 1;
                warnPos = count - Math.floor(warnLight * count) - 1;
            }

            var i = 0;
            for (; i < count; i++) {
                if (i === warnPos) {
                    comm.mask(lights[i], function(value, ticks) {
                        return (ticks % 2 > 0) ? !value : value; 
                    }, true);
                } else if (i === pos) {
                    comm.mask(lights[i], function(value) { return !value; }); // Invert
                } else {
                    comm.unmask(lights[i]);
                }
            }
        });
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
        return {
            'cycle': function(pos) { return function() {
                var last = pos.indexOf(engaged);
                var next = 0;
                if (last !== -1) {
                    var next = (last + 1) % pos.length;
                }
                var prev = engaged;
                engaged = pos[next];
                return engaged !== prev;
            }},
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
                comm.clear();
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
        watch(channel, 'filterLow', Centerbar(device.slider.left.meter)); 
        watch(channel, 'filterMid', Centerbar(device.slider.middle.meter)); 
        watch(channel, 'filterHigh', Centerbar(device.slider.right.meter));
        
        expect(device.slider.left.slide.abs, set(channel, 'filterLow'));
        expect(device.slider.middle.slide.abs, set(channel, 'filterMid'));
        expect(device.slider.right.slide.abs, set(channel, 'filterHigh'));
    }

    function looppatch() {
        tell(device.mode.loop.light.red);
    }

    function Trigpatch(trigset) {
        return function(channel) {
            tell(device.modeset.button);
            tell(device.mode.trig.light.bits(trigset+1));

            var i = 0;
            var offset = trigset * 5;
            for (; i < 5; i++) {
                var hotcue = offset + i + 1;
                var field = device.field[i];
                expect(field.touch, setConst(channel, 'hotcue_'+hotcue+'_activate', true));
                watch(channel, 'hotcue_'+hotcue+'_enabled', binarylight(field.light.black, field.light.red));
            }
        }
    }

    var trigpatches = [
        Trigpatch(0),
        Trigpatch(1),
        Trigpatch(2)
    ];

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

        watch(channel, 'volume', Bar(device.gain.meter));

        var activeMode = mode[channelno];
        tell(device.mode.fx.light.black);
        tell(device.mode.eq.light.black);
        tell(device.mode.loop.light.black);
        tell(device.mode.trig.light.black);
        tell(device.mode.vinyl.light.black);
        expect(device.mode.fx.touch, repatch(activeMode.cycle([fxpatch])));
        expect(device.mode.eq.touch, repatch(activeMode.cycle([eqpatch])));
        expect(device.mode.loop.touch, repatch(activeMode.cycle([looppatch])));
        expect(device.mode.trig.touch, repatch(activeMode.cycle(trigpatches)));
        expect(device.mode.vinyl.touch, repatch(activeMode.cycle([vinylpatch])));
        expect(device.mode.deck.touch, repatch(side.toggle));
        
        // Reset circle lights
        Bar(device.slider.circle.meter)(0);
        
        // Call the patch function that was put into the switch with engage()
        activeMode.active()(channel);

        expect(device.button.play.touch, toggle(channel, 'play'));
        watch(channel, 'play', binarylight(device.button.play.light.black, device.button.play.light.red));
        
        expect(device.button.cue.touch, setConst(channel, 'cue_default', true));
        expect(device.button.cue.release, setConst(channel, 'cue_default', false));
        watch(channel, 'cue_default', binarylight(device.button.cue.light.black, device.button.cue.light.red));
        
        expect(device.button.sync.touch, setConst(channel, 'beatsync', true));
        tell(device.button.sync.light.black);
        
        expect(device.button.tap.touch, function() { taps(channel); });
        watch(channel, 'beat_active', binarylight(device.button.tap.light.black, device.button.tap.light.red));

        spinLight(channel, 30);

        // Read deck state from unrelated control which may be set by the 3m
        // Among all the things WRONG about this, two stand out:
        // 1. The control is not meant to transmit this information.
        // 2. A value > 1 is expected from a control which is just a toggle (suggesting a binary value)
        // This may fail at any future or past version of Mixxx and you have only me to blame for it.
        watch('[PreviewDeck1]', 'quantize', repatch(gleanChannel));
    }

    var timer = false;

    return {
        start: function() {
            tell(device.modeset.flat);
            patchage();
            if (!timer) timer = engine.beginTimer(100, comm.tick);
        },
        receive: comm.receive,
        stop: function() {
            if (timer) engine.stopTimer(timer);
            clear();
            tell(device.lightsoff);
            send(device.logo.on, true);
        }
    }
}
