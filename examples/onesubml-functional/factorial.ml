// A direct subset of 1SubML's recursive function syntax.
let rec factorial = fun value ->
  if value == 0 then 1 else value * factorial (value - 1);

let gpu_main = factorial 5;
