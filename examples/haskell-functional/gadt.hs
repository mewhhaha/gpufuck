{-# LANGUAGE GADTs #-}
module Gadt where

data Equal a b where
    Refl :: Equal a a

cast :: Equal a b -> a -> b
cast proof value =
    case proof of
        Refl -> value

gpuMain = cast Refl 42
