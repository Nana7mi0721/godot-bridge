extends Node2D
## Main scene driver. Prints one line and quits, so both
## `godot --headless --quit-after N` and a normal windowed run behave.

@onready var label: Label = $Label

## Bumped through the agent-facing bridge (`godot_command` call_method) to prove
## the in-game TCP interaction server reaches real scene properties.
var probe_calls: int = 0


func _ready() -> void:
	if label:
		label.text = "godot-bridge demo"
	Game.add_score(5)
	print("[Main] ready — Godot %s" % Engine.get_version_info().get("string"))


func add_probe_calls(amount: int = 1) -> int:
	probe_calls += amount
	print("[Main] probe_calls=%d" % probe_calls)
	return probe_calls


func _process(_delta: float) -> void:
	if Input.is_action_just_pressed("ui_cancel"):
		get_tree().quit()
