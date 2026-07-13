"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
";" @punctuation.delimiter
"=" @operator
"|" @operator
(case_expr "case" @keyword)
(case_expr "end" @keyword)
(case_expr "of" @keyword)
(data_declaration "data" @keyword)
(definition "fn" @keyword)
(fun_expr "fun" @keyword)
(if_expr "else" @keyword)
(if_expr "if" @keyword)
(if_expr "then" @keyword)
(let_expr "in" @keyword)
(let_expr "let" @keyword)
(let_rec_expr "in" @keyword)
(let_rec_expr "let" @keyword)
(let_rec_expr "rec" @keyword)
(integer) @number
(boolean) @constant.builtin
(INTEGER) @number
(COMMENT) @comment
(fun_expr param: (IDENT) @variable)
(let_expr name: (IDENT) @variable)
(let_rec_expr name: (IDENT) @variable)
(let_rec_expr parameter: (IDENT) @variable)
(variable name: (IDENT) @variable)
