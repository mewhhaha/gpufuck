type 'a tree =
  | Leaf of 'a
  | Branch of 'a tree * 'a tree

let rec map_tree function_value tree =
  match tree with
  | Leaf value -> Leaf (function_value value)
  | Branch (left, right) ->
      Branch (map_tree function_value left, map_tree function_value right)

let rec sum_tree tree =
  match tree with
  | Leaf value -> value
  | Branch (left, right) -> sum_tree left + sum_tree right

let gpu_main =
  sum_tree (map_tree (fun value -> value + 1) (Branch (Leaf 19, Leaf 21)))
