StantonSCS3m = {
    timer: false
}

StantonSCS3d.init = function(id) {
    this.device = this.Device();
    this.agent = this.Agent(this.device);
    this.agent.start();
    this.timer = engine.beginTimer(20, this.agent.tick);
}

StantonSCS3d.shutdown = function() {
    if (StantonSCS3d.timer) engine.stopTimer(StantonSCS3d.timer);
    StantonSCS3d.agent.stop();
}

StantonSCS3d.receive = function(channel, control, value, status) {
    StantonSCS3d.agent.receive(status, control, value)
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
    
    function Meter(id, lights) {
        // Returns messages that light or extinguish the individual LED
        // of the meter. sel() is called for each light [1..lights]
        // and must return a boolean 
        function bitlights(sel) {
            var msgs = new Array(lights);
            
            // The meter lights are enumerated top-bottom
            // The sel() function gets lowest led = 1, top led = lights
            var i = 1;
            var maxlight = id + lights;
            for (; i <= lights; i++) {
                msgs[i] = [NoteOn, maxlight - i, +sel(i)];
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
    
    function LightedSlider(id, meterid, lights, lightid) {
        var slider = Slider(id, meterid, lights);
        slider.light = Light(lightid);
        return slider;
    }
        
    function Touch(id) {
        return {
            light: Light(id),
            touch: [NoteOn, id],
            release: [NoteOff, id]
        }
    }

    return {
        flat: [0xF0, 0x7E, channel, 0x06, 0x01, 0xF7],
        logo: Logo(),
        gain: LightedSlider(0x07, 0x34, 9, 0x71);
        pitch: LightedSlider(0x03, 0x3F, 9, 0x72);
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
        circle: Slider(0x62, 0x5d, 16),
        center: {
            left: Slider(0x0C, 0x48, 7),
            middle: Slider(0x01, 0x56, 7),
            right: Slider(0x0E, 0x4F, 7)
        },
        bottom: {
            left: Touch(0x30),
            right: Touch(0x32)
        }
    }
}

