module Unicode where

lengthString [] = 0
lengthString (_ : rest) = 1 + lengthString rest

gpuMain = if 'λ' == 'λ' then 40 + lengthString "λ🙂" else 0
