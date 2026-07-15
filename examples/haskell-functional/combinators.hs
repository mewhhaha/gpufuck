module Combinators where {
identity :: a -> a;
identity value = value;

constant :: a -> b -> a;
constant value ignored = value;

compose :: (b -> c) -> (a -> b) -> a -> c;
compose outer inner value = outer (inner value);

flipArguments :: (a -> b -> c) -> b -> a -> c;
flipArguments function second first = function first second;

curryPair :: ((a, b) -> c) -> a -> b -> c;
curryPair function first second = function (first, second);

uncurryPair :: (a -> b -> c) -> (a, b) -> c;
uncurryPair function pair =
    case pair of { (first, second) -> function first second };

increment :: Int -> Int;
increment value = value + 1;

add :: Int -> Int -> Int;
add left right = left + right;

subtractValues :: Int -> Int -> Int;
subtractValues left right = left - right;

addPair :: (Int, Int) -> Int;
addPair pair = case pair of { (left, right) -> left + right };

ignoreUnit :: () -> Int;
ignoreUnit ignored = 42;

gpuMain =
    let {
        composed = compose increment (add 20) 21;
        flipped = flipArguments subtractValues 8 50;
        curried = curryPair addPair 20 22;
        uncurried = uncurryPair add (20, 22)
    } in
        if identity True then
            if composed == 42 then
                if flipped == 42 then
                    if curried == 42 then
                        if uncurried == 42 then
                            if ignoreUnit () == 42 then constant 42 False else 0
                        else 0
                    else 0
                else 0
            else 0
        else 0
}
