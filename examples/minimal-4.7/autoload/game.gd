extends Node
## Tiny autoload used to prove that the plugin's GDScript validator
## (validate_script.gd) resolves autoload globals instead of reporting
## them as "Identifier not found".

var score: int = 0


func add_score(amount: int) -> void:
	score += amount
	print("[Game] score=%d" % score)
