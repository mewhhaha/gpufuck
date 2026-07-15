module Classes where

class Equal a where
    equal :: a -> a -> Bool

instance Equal Int where
    equal left right = left == right

same :: Equal a => a -> a -> Bool
same left right = equal left right

fortyTwo :: Int
fortyTwo = 42

twenty :: Int
twenty = 20

twentyTwo :: Int
twentyTwo = 22

gpuMain =
    if same fortyTwo fortyTwo then
        if same twenty twentyTwo then 0 else fortyTwo
    else 0
