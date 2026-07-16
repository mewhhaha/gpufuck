let add_one = fun value -> value + 1;

// Application is right-associative in 1SubML, so f f value means f (f value).
let twice = fun f -> fun value -> f f value;

let gpu_main = (twice add_one) 40;
