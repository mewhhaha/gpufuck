module Tuple where {
identity value = value;

choose :: Bool -> (Int, Int) -> Int;
choose flag pair =
    if flag
        then case pair of { (left, right) -> left + right }
        else 0;

gpuMain =
    let {
        pair = identity (20, 22);
        flag = identity True
    } in choose flag pair
}
