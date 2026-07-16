let identity = fun[T] value: T :: T -> value;

let consume = fun f: ([T]. T -> T) :: int ->
  if f true then f 42 else 0;

let with_identity = fun consumer: (([T]. T -> T) -> int) :: int ->
  consumer identity;

let gpu_main = with_identity consume;
