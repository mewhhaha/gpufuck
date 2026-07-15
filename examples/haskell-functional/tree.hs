module Tree where {
data Tree a = Leaf a | Branch (Tree a) (Tree a);

increment :: Int -> Int;
increment value = value + 1;

mapTree function tree =
    case tree of {
        Leaf value -> Leaf (function value);
        Branch left right -> Branch (mapTree function left) (mapTree function right)
    };

sumTree :: Tree Int -> Int;
sumTree tree =
    case tree of {
        Leaf value -> value;
        Branch left right -> sumTree left + sumTree right
    };

gpuMain = sumTree (mapTree increment (Branch (Leaf 19) (Leaf 21)))
}
