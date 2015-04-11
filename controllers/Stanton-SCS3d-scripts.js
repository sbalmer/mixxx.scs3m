StantonSCS3m.Device = function(channel) {
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
        function bitlights(sel) {
            var i = 1;
            var msgs = new Array(lights);
            for (; i <= lights) {
                msgs[i] = [NoteOn, id + lights - i, sel(i);
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
    
    function Slider(id, lights) {
        return {
            meter: Meter(id, lights),
            slide: [CC, id],
            relslide: [CC, id + 1]
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

    return {
        flat: [0xF0, 0x7E, channel, 0x06, 0x01, 0xF7],
        logo: Logo()
    }
}