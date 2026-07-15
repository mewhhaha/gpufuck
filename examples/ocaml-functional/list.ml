let rec map_list function_value values =
  match values with
  | [] -> []
  | head :: tail -> function_value head :: map_list function_value tail

let rec sum_list values =
  match values with
  | [] -> 0
  | head :: tail -> head + sum_list tail

let gpu_main = sum_list (map_list (fun value -> value + 1) [19; 21])
