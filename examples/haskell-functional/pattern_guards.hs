module PatternGuards where

data Option a = None | Some a

describe :: Option Int -> Int
describe None = 0
describe (Some value)
    | value < 0 = 0 - value
    | otherwise = adjusted
    where
        adjusted = value + 1

nestedSum :: Option (Int, Int) -> Int
nestedSum None = 0
nestedSum (Some (left, right)) = left + right

gpuMain =
    if describe (Some 41) == 42 then
        if nestedSum (Some (20, 22)) == 42 then 42 else 0
    else 0
