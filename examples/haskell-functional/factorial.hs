module Factorial where {
factorial :: Int -> Int;
factorial value =
    if value == 0
        then 1
        else value * factorial (value - 1);

gpuMain = factorial 5
}
