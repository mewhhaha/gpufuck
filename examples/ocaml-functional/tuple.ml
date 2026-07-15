let swap pair =
  match pair with
  | (left, right) -> (right, left)

let gpu_main =
  match swap (22, 20) with
  | (left, right) -> left + right
