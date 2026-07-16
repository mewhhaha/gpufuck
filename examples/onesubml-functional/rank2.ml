let identity = fun[T] value: T :: T -> value;

let use = fun f: ([T]. T -> T) :: (int, bool) ->
  (f 42, f true);

let gpu_main = (
  let (answer, condition) = use identity;
  if condition then answer else 0
);
