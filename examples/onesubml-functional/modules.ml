(* 1SubML modules are records used as ordinary values. *)
let counter = {
  new = 0;
  increment = fun (value, amount) -> value + amount;
  get = fun value -> value;
};

let gpu_main = counter.get (counter.increment (counter.new, 42));
