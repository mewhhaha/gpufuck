module ListAlgorithms where {
data List a = Nil | Cons a (List a);

mapList :: (a -> b) -> List a -> List b;
mapList function values =
    case values of {
        Nil -> Nil;
        Cons headValue tailValues -> Cons (function headValue) (mapList function tailValues)
    };

filterList :: (a -> Bool) -> List a -> List a;
filterList predicate values =
    case values of {
        Nil -> Nil;
        Cons headValue tailValues ->
            if predicate headValue
                then Cons headValue (filterList predicate tailValues)
                else filterList predicate tailValues
    };

foldRight :: (a -> b -> b) -> b -> List a -> b;
foldRight combine emptyValue values =
    case values of {
        Nil -> emptyValue;
        Cons headValue tailValues -> combine headValue (foldRight combine emptyValue tailValues)
    };

zipWithList :: (a -> b -> c) -> List a -> List b -> List c;
zipWithList combine leftValues rightValues =
    case leftValues of {
        Nil -> Nil;
        Cons leftHead leftTail ->
            case rightValues of {
                Nil -> Nil;
                Cons rightHead rightTail ->
                    Cons (combine leftHead rightHead) (zipWithList combine leftTail rightTail)
            }
    };

increment :: Int -> Int;
increment value = value + 1;

greaterThanTen :: Int -> Bool;
greaterThanTen value = value > 10;

add :: Int -> Int -> Int;
add left right = left + right;

sumList :: List Int -> Int;
sumList values = foldRight add 0 values;

gpuMain =
    let {
        values = Cons 10 (Cons 20 Nil);
        mappedSum = sumList (mapList increment values);
        filteredSum = sumList (filterList greaterThanTen values);
        zippedSum = sumList (zipWithList add values values)
    } in
        if mappedSum == 32 then
            if filteredSum == 20 then
                if zippedSum == 60 then 42 else 0
            else 0
        else 0
}
