extends CharacterBody2D
## Sample scene script: touches the Game autoload on purpose so the
## validator has to resolve a global class name.

const SPEED := 260.0

var speed: float = SPEED


func _physics_process(delta: float) -> void:
	var direction := Input.get_axis("ui_left", "ui_right")
	velocity.x = direction * speed
	move_and_slide()


func _ready() -> void:
	Game.add_score(1)
	print("[Player] ready, speed=%s" % speed)
