"!" @operator
"#" @operator
"&&" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"," @punctuation.delimiter
"->" @operator
"." @punctuation.delimiter
":" @punctuation.delimiter
"<-" @operator
"<<" @operator
"<>" @operator
"=" @operator
">>" @operator
"@external" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"|" @operator
"|>" @operator
"||" @operator
"}" @punctuation.bracket
(assert_expression "assert" @keyword)
(body_function_declaration "fn" @keyword)
(case_expression "case" @keyword)
(case_guard "if" @keyword)
(constant_declaration "const" @keyword)
(external_function_declaration "fn" @keyword)
(function_type "fn" @keyword)
(import_alias "as" @keyword)
(import_declaration "import" @keyword)
(lambda_expression "fn" @keyword)
(let_binding "let" @keyword)
(panic_expression "panic" @keyword)
(panic_message "as" @keyword)
(pattern_alias "as" @keyword)
(type_declaration "type" @keyword)
(type_import_name "type" @keyword)
(use_binding "use" @keyword)
(type_import_name) @type
(type_declaration) @type
(type_declaration_body) @type
(custom_type_body) @type
(type_alias_body) @type
(type_parameters) @type
(constructor_field_list) @variable.other.member
(constructor_field_tail) @variable.other.member
(constructor_field) @variable.other.member
(labeled_constructor_field) @variable.other.member
(positional_constructor_field) @variable.other.member
(constant_declaration) @constant.builtin
(type_annotation) @type
(source_type) @type
(function_type) @type
(tuple_type) @type
(named_type) @type
(type_arguments) @type
(type_list) @type
(type_tail) @type
(float_lt) @number
(float_le) @number
(float_gt) @number
(float_ge) @number
(float_plus) @number
(float_minus) @number
(float_star) @number
(float_slash) @number
(boolean_not) @constant.builtin
(field_access) @variable.other.member
(string_expression) @string
(float_expression) @number
(integer_expression) @number
(boolean_expression) @constant.builtin
(integer_pattern) @number
(float_pattern) @number
(boolean_pattern) @constant.builtin
(string_prefix_pattern) @string
(string_pattern) @string
(FLOAT) @number
(INTEGER) @number
(STRING) @string
(COMMENT) @comment
(body_function_declaration name: (IDENT) @function)
(external_attribute target: (IDENT) @variable)
(external_function_declaration name: (IDENT) @function)
(labeled_call_argument label: (IDENT) @label)
(labeled_constructor_field label: (IDENT) @label)
(labeled_function_parameter label: (IDENT) @label)
(labeled_function_parameter name: (IDENT) @function)
(labeled_pattern_argument label: (IDENT) @label)
(named_type name: (qualified_name) @type)
(positional_function_parameter name: (IDENT) @function)
(type_declaration name: (IDENT) @type)
(type_import_name name: (IDENT) @type)
