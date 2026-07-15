type 'a option_value =
  | None
  | Some of 'a

let increment value = value + 1

let map_option function_value option =
  match option with
  | None -> None
  | Some value -> Some (function_value value)

let gpu_main =
  match map_option increment (Some 41) with
  | None -> 0
  | Some value -> value
