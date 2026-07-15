module ManualDictionary where {
data EqDict a = EqDict (a -> a -> Bool);

equalWith :: EqDict a -> a -> a -> Bool;
equalWith dictionary left right =
    case dictionary of {
        EqDict equal -> equal left right
    };

equalInt :: Int -> Int -> Bool;
equalInt left right = left == right;

equalPairWith firstDictionary secondDictionary left right =
    case left of {
        (leftFirst, leftSecond) ->
            case right of {
                (rightFirst, rightSecond) ->
                    if equalWith firstDictionary leftFirst rightFirst then
                        equalWith secondDictionary leftSecond rightSecond
                    else False
            }
    };

pairDictionary firstDictionary secondDictionary =
    EqDict (equalPairWith firstDictionary secondDictionary);

gpuMain =
    let {
        integers = EqDict equalInt;
        pairs = pairDictionary integers integers
    } in
        if equalWith pairs (20, 22) (20, 22) then
            if equalWith pairs (20, 22) (20, 23) then 0 else 42
        else 0
}
