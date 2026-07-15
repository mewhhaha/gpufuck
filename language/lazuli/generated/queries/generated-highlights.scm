"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
":" @punctuation.delimiter
";" @punctuation.delimiter
"=" @operator
"=>" @operator
"@" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"|" @operator
"}" @punctuation.bracket
(case_expr "case" @keyword)
(case_expr "end" @keyword)
(case_expr "of" @keyword)
(const_declaration "const" @keyword)
(data_declaration "data" @keyword)
(definition "fn" @keyword)
(fun_expr "fun" @keyword)
(if_expr "else" @keyword)
(if_expr "if" @keyword)
(if_expr "then" @keyword)
(let_declaration "let" @keyword)
(let_expr "in" @keyword)
(let_expr "let" @keyword)
(let_rec_expr "in" @keyword)
(let_rec_expr "let" @keyword)
(let_rec_expr "rec" @keyword)
(constructor_field_list) @variable.other.member
(constructor_field_tail) @variable.other.member
(constructor_field) @variable.other.member
(const_declaration) @constant.builtin
(const_parameter) @constant.builtin
(const_parameter_bind) @constant.builtin
(const_parameter_tuple) @constant.builtin
(const_parameter_record) @constant.builtin
(const_parameter_field_list) @constant.builtin
(const_parameter_field_tail) @constant.builtin
(const_parameter_field) @constant.builtin
(source_type) @type
(type_function_tail) @type
(type_application) @type
(type_atom) @type
(type_named) @type
(type_unit) @type
(type_tuple) @type
(type_group) @type
(const_instantiation) @constant.builtin
(const_descriptor) @constant.builtin
(const_descriptor_hole) @constant.builtin
(const_descriptor_tuple) @constant.builtin
(const_descriptor_record) @constant.builtin
(const_descriptor_field_list) @constant.builtin
(const_descriptor_field_tail) @constant.builtin
(const_descriptor_field) @constant.builtin
(string) @string
(record) @type
(record_fields) @type
(record_tail) @type
(record_field) @variable.other.member
(integer) @number
(boolean) @constant.builtin
(INTEGER) @number
(STRING) @string
(COMMENT) @comment
(arrow_expr param: (IDENT) @variable)
(const_descriptor_field name: (IDENT) @variable.other.member)
(const_parameter_bind name: (IDENT) @variable)
(const_parameter_field name: (IDENT) @variable.other.member)
(constructor_field name: (IDENT) @variable.other.member)
(fun_expr param: (IDENT) @variable)
(let_declaration name: (IDENT) @variable)
(let_expr name: (IDENT) @variable)
(let_rec_expr name: (IDENT) @variable)
(let_rec_expr parameter: (IDENT) @variable)
(record_field name: (IDENT) @type)
(type_named name: (IDENT) @type)
