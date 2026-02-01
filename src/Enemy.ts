import * as THREE from 'three'
import { initThreeMeshBVH, setRaycasterFirstHitOnly } from './bvh'
import { TankAttack } from './TankAttack'
import {Vector3} from "three";

export type EnemyState = 'idle' | 'pursuing' | 'dying' | 'dead'

export type EnemyType = 0 | 1

export interface EnemyUpdateParams {
  dt: number
  camera: THREE.Camera
  playerPosition: THREE.Vector3
  collisionMeshes: THREE.Mesh[]
}

export class Enemy {
  readonly mesh: THREE.Mesh
  readonly type: EnemyType
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private time: number = 0
  private lastAttackTime: number = 0
  attacks: TankAttack[] = []

  // Enemy0 orb attack (driven by Game.ts via events)
  private orbCharging = false
  private orbChargeStartTime = 0
  private lastOrbAttackTime = -999
  private readonly orbChargeDurationSeconds = 3.0
  private readonly orbCooldownSeconds = 6.0
  private readonly orbPreferredDistance = 4.0
  private readonly orbPreferredWindow = 1.0
  private orbChargeStartedEvent = false
  private orbShotEvent = false
  private readonly orbShotDir = new THREE.Vector3()

  private spriteSheet: HTMLImageElement
  private spriteReady = false
  private pursuitAnimTime = 0
  private deathAnimTime = 0
  private hideOnNextUpdate = false
  private spawnExplosionEvent = false
  private lastDrawnFrame = -1

  // Internal resolution
  private readonly width = 16
  private readonly height = 32

  // Sprite sheet (enemy0.png / enemy1.png)
  private readonly frameW = 16
  private readonly frameH = 32
  private readonly sheetCols = 4
  private readonly pursuitFPS = 12
  private readonly pursuitFrameCount = 7

  // Death animation (enemy type 0 only; stored on the 3rd row of enemy0.png)
  private readonly deathFPS = 12
  private readonly deathFrameCount = 5
  private readonly deathStartFrame = this.sheetCols * 2

  // Physics
  private velocity = new THREE.Vector3()
  private grounded = false
  private readonly enemyHeight = 2 // Half the visual height (pivot is center)
  private readonly enemyRadius = 0.5

  // Physics constants
  private readonly gravity = 32
  private readonly moveSpeed = 6
  private readonly friction = 8

  // State
  state: EnemyState = 'idle'
  isAttacking = false
  attackStartTime = 0
  attackPreparationTime = 0.8 // Time to stand still before shooting
  attackDuration = 1.5 // Total attack time

  alive = true

  // Reusable vectors for performance
  private readonly rayOrigin = new THREE.Vector3()
  private readonly rayDir = new THREE.Vector3()
  private readonly toPlayer = new THREE.Vector3()
  private readonly cameraPos = new THREE.Vector3()
  private readonly groundRaycaster = new THREE.Raycaster()
  private readonly wallRaycaster = new THREE.Raycaster()
  private readonly groundHits: THREE.Intersection[] = []
  private readonly wallHits: THREE.Intersection[] = []
  private readonly wallDirs = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0.707, 0, 0.707),
    new THREE.Vector3(-0.707, 0, 0.707),
    new THREE.Vector3(0.707, 0, -0.707),
    new THREE.Vector3(-0.707, 0, -0.707),
  ]

  constructor(position: Vector3, state: EnemyState = 'idle', type: EnemyType = 0) {
    initThreeMeshBVH()

    this.type = type

    // Create offscreen canvas at internal resolution
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.width
    this.canvas.height = this.height
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.imageSmoothingEnabled = false

    // Create texture with nearest neighbor filtering for pixelated look
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false

    // Create sprite material and plane geometry
    // Scale the plane to match aspect ratio (16:32 = 1:2)
    const scale = 2 // Adjust this to change world size
    const geometry = new THREE.PlaneGeometry(scale, scale * 2)
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: 0.5, // Prevent fully transparent pixels from writing depth
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.position.copy(position)

    this.state = state

    // Setup raycasters
    this.groundRaycaster.far = this.enemyHeight + 0.5
    this.wallRaycaster.far = this.enemyRadius + 0.1
    setRaycasterFirstHitOnly(this.groundRaycaster, true)
    setRaycasterFirstHitOnly(this.wallRaycaster, true)

    // Load sprite sheet; fall back to checkerboard until ready
    this.spriteSheet = new Image()
    this.spriteSheet.onload = () => {
      this.spriteReady = true
      this.renderSpriteFrame(0)
    }
    this.spriteSheet.src = this.type === 1 ? '/sprites/enemy1.png' : '/sprites/enemy0.png'

    // Initial render
    this.renderCheckerboard()
  }

  consumeOrbChargeStartedEvent(): boolean {
    const v = this.orbChargeStartedEvent
    this.orbChargeStartedEvent = false
    return v
  }

  consumeOrbShotDirection(): THREE.Vector3 | null {
    if (!this.orbShotEvent) return null
    this.orbShotEvent = false
    return this.orbShotDir.clone()
  }

  get isOrbCharging(): boolean {
    return this.orbCharging
  }

  private renderCheckerboard(): void {
    const ctx = this.ctx
    const tileSize = 4 // 4x4 pixel tiles
    const offset = Math.floor(this.time * 4) % (tileSize * 2) // Animation offset

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // Animate by shifting the pattern
        const shiftedX = x + offset
        const isLight = (Math.floor(shiftedX / tileSize) + Math.floor(y / tileSize)) % 2 === 0
        ctx.fillStyle = isLight ? '#ff00ff' : '#00ffff'
        ctx.fillRect(x, y, 1, 1)
      }
    }

    this.texture.needsUpdate = true
  }

  private renderSpriteFrame(frameIndex: number): void {
    if (!this.spriteReady) return
    if (frameIndex === this.lastDrawnFrame) return

    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)

    const clamped = Math.max(0, Math.floor(frameIndex))
    const sx = (clamped % this.sheetCols) * this.frameW
    const sy = Math.floor(clamped / this.sheetCols) * this.frameH
    ctx.drawImage(this.spriteSheet, sx, sy, this.frameW, this.frameH, 0, 0, this.width, this.height)

    this.lastDrawnFrame = frameIndex
    this.texture.needsUpdate = true
  }

  get hitRadius(): number {
    return this.enemyRadius
  }

  get halfHeight(): number {
    return this.enemyHeight
  }

  get isHittable(): boolean {
    return this.alive
  }

  kill(): void {
    if (!this.alive) return
    this.alive = false

    this.velocity.set(0, 0, 0)
    this.pursuitAnimTime = 0

    // All enemy types now play death animation
    this.state = 'dying'
    this.deathAnimTime = 0
    this.hideOnNextUpdate = false
    this.spawnExplosionEvent = false
    this.lastDrawnFrame = -1
  }

  consumeExplosionEvent(): boolean {
    const v = this.spawnExplosionEvent
    this.spawnExplosionEvent = false
    return v
  }

  private checkGround(pos: THREE.Vector3, collisionMeshes: THREE.Mesh[]): { grounded: boolean; groundY: number } {
    this.rayOrigin.set(pos.x, pos.y, pos.z)
    this.rayDir.set(0, -1, 0)
    this.groundRaycaster.set(this.rayOrigin, this.rayDir)

    // Check map collision
    if (collisionMeshes.length > 0) {
      this.groundHits.length = 0
      this.groundRaycaster.intersectObjects(collisionMeshes, false, this.groundHits)
      if (this.groundHits.length > 0) {
        const dist = this.groundHits[0].distance
        if (dist <= this.enemyHeight + 0.1) {
          return { grounded: true, groundY: this.groundHits[0].point.y }
        }
      }
    }

    return { grounded: false, groundY: 0 }
  }

  private resolveWallCollision(pos: THREE.Vector3, vel: THREE.Vector3, collisionMeshes: THREE.Mesh[]): void {
    if (collisionMeshes.length === 0) return

    // Check at multiple heights
    const height0 = 0.2
    const height1 = this.enemyHeight * 0.5
    const height2 = this.enemyHeight - 0.1

    for (let h = 0; h < 3; h++) {
      const height = h === 0 ? height0 : h === 1 ? height1 : height2
      for (const dir of this.wallDirs) {
        this.rayOrigin.set(pos.x, pos.y - this.enemyHeight + height, pos.z)
        this.wallRaycaster.set(this.rayOrigin, dir)
        this.wallRaycaster.far = this.enemyRadius + 0.05

        this.wallHits.length = 0
        this.wallRaycaster.intersectObjects(collisionMeshes, false, this.wallHits)
        if (this.wallHits.length > 0) {
          const hit = this.wallHits[0]
          const penetration = this.enemyRadius - hit.distance + 0.01
          if (penetration > 0) {
            // Push enemy out
            pos.x -= dir.x * penetration
            pos.z -= dir.z * penetration

            // Kill velocity into the wall
            const velDot = vel.x * dir.x + vel.z * dir.z
            if (velDot > 0) {
              vel.x -= dir.x * velDot
              vel.z -= dir.z * velDot
            }
          }
        }
      }
    }
  }

  /**
   * Update the enemy - call each frame
   */
  update(params: EnemyUpdateParams): void {
    const { dt, camera, playerPosition, collisionMeshes } = params
    this.time += dt

    if (this.hideOnNextUpdate) {
      this.hideOnNextUpdate = false
      this.mesh.visible = false
      return
    }

    const pos = this.mesh.position

    // Ground check
    const groundCheck = this.checkGround(pos, collisionMeshes)
    this.grounded = groundCheck.grounded

    if (this.grounded) {
      const targetY = groundCheck.groundY + this.enemyHeight
      if (pos.y < targetY) {
        pos.y = targetY
        if (this.velocity.y < 0) this.velocity.y = 0
      }
    }

// Calculate distance to player for state transitions
    this.toPlayer.set(playerPosition.x - pos.x, 0, playerPosition.z - pos.z)
    const distance = this.toPlayer.length()

    // State transitions
    if (this.state === 'idle' && distance < 15.0) {
      // Start pursuing when player is within detection range
      this.state = 'pursuing'
    } else if (this.state === 'pursuing' && distance > 25.0) {
      // Stop pursuing when player is too far away
      this.state = 'idle'
    }

    // Enemy0 orb attack state machine (charge -> shoot)
    if (this.type === 0 && this.alive && this.state === 'pursuing') {
      // Avoid triggering when GameLoop is "pausing" enemies by passing playerPosition = enemyPosition.
      const canStartCharge =
        !this.orbCharging &&
        distance > 0.75 &&
        Math.abs(distance - this.orbPreferredDistance) <= this.orbPreferredWindow &&
        this.time - this.lastOrbAttackTime >= this.orbCooldownSeconds

      if (canStartCharge) {
        this.orbCharging = true
        this.orbChargeStartTime = this.time
        this.orbChargeStartedEvent = true
      }

      if (this.orbCharging) {
        const elapsed = this.time - this.orbChargeStartTime
        if (elapsed >= this.orbChargeDurationSeconds) {
          this.orbCharging = false
          this.lastOrbAttackTime = this.time
          // Aim at the player at the moment of firing.
          this.orbShotDir.set(playerPosition.x - pos.x, playerPosition.y - pos.y, playerPosition.z - pos.z)
          if (this.orbShotDir.lengthSq() > 1e-6) this.orbShotDir.normalize()
          else this.orbShotDir.set(0, 0, -1)
          this.orbShotEvent = true
        }
      }
    }

    // State-based behavior
    if (this.state === 'pursuing' && this.alive) {
      if (!(this.type === 0 && this.orbCharging)) {
        this.pursuitAnimTime += dt
      }

      // Enemy0 keeps a bit more distance from the player.
      const desiredDistance = this.type === 0 ? 4.0 : 1.5
      const buffer = this.type === 0 ? 0.5 : 0

      if (this.type === 0 && this.orbCharging) {
        // Stand still during charge.
        this.velocity.x = 0
        this.velocity.z = 0
      } else if (distance > desiredDistance + buffer) {
        // Approach
        if (distance > 1e-6) this.toPlayer.multiplyScalar(1 / distance)

        if (this.grounded) {
          this.velocity.x = this.toPlayer.x * this.moveSpeed
          this.velocity.z = this.toPlayer.z * this.moveSpeed
        } else {
          this.velocity.x += this.toPlayer.x * this.moveSpeed * 0.1 * dt
          this.velocity.z += this.toPlayer.z * this.moveSpeed * 0.1 * dt
        }
      } else if (this.type === 0 && distance > 0.5 && distance < desiredDistance - buffer) {
        // Too close: back off a bit.
        if (distance > 1e-6) this.toPlayer.multiplyScalar(1 / distance)
        if (this.grounded) {
          this.velocity.x = -this.toPlayer.x * this.moveSpeed
          this.velocity.z = -this.toPlayer.z * this.moveSpeed
        } else {
          this.velocity.x += -this.toPlayer.x * this.moveSpeed * 0.1 * dt
          this.velocity.z += -this.toPlayer.z * this.moveSpeed * 0.1 * dt
        }
      } else {
        // In the sweet spot: stop.
        if (this.grounded) {
          this.velocity.x = 0
          this.velocity.z = 0
        }
      }
    } else if (this.state === 'idle') {
      this.pursuitAnimTime = 0
      // Idle: apply friction
      if (this.grounded) {
        const speed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z)
        if (speed > 0.1) {
          const drop = speed * this.friction * dt
          const scale = Math.max(speed - drop, 0) / speed
          this.velocity.x *= scale
          this.velocity.z *= scale
        } else {
          this.velocity.x = 0
          this.velocity.z = 0
        }
      }
    } else {
      // Dying/dead: no horizontal movement
      this.pursuitAnimTime = 0
      this.velocity.x = 0
      this.velocity.z = 0
    }

    // Gravity
    if (!this.grounded) {
      this.velocity.y -= this.gravity * dt
    }

    // Apply velocity
    pos.x += this.velocity.x * dt
    pos.z += this.velocity.z * dt
    pos.y += this.velocity.y * dt

    // Wall collision
    this.resolveWallCollision(pos, this.velocity, collisionMeshes)

    // Final ground clamp
    const finalGround = this.checkGround(pos, collisionMeshes)
    if (finalGround.grounded) {
      const targetY = finalGround.groundY + this.enemyHeight
      if (pos.y < targetY) {
        pos.y = targetY
        if (this.velocity.y < 0) this.velocity.y = 0
        this.grounded = true
      }
    }

    // Fallback floor (only if no collision meshes loaded yet)
    if (collisionMeshes.length === 0 && pos.y < this.enemyHeight) {
      pos.y = this.enemyHeight
      if (this.velocity.y < 0) this.velocity.y = 0
      this.grounded = true
    }

    // Tank attack logic
    if (this.type === 1) {
      // Check if tank should attack (when pursuing and close enough)
      if (this.state === 'pursuing' && !this.isAttacking) {
        const attackDistance = this.toPlayer.length()
        if (attackDistance < 8.0) { // Attack range
          // Attack every 2 seconds, but track last attack time
          if (!this.lastAttackTime) this.lastAttackTime = 0
          if (this.time - this.lastAttackTime > 2.0) {
            this.isAttacking = true
            this.attackStartTime = this.time
            this.lastAttackTime = this.time
          }
        }
      }
      
      // Handle attacking state
      if (this.isAttacking) {
        const attackElapsed = this.time - this.attackStartTime
        
        // Stand still during preparation and shooting
        this.velocity.x = 0
        this.velocity.z = 0
        
        // Shoot laser after preparation
        if (attackElapsed >= this.attackPreparationTime && this.attacks.length === 0) {
          const attack = new TankAttack(
            pos.clone(),
            playerPosition.clone(),
            collisionMeshes
          )
          this.attacks.push(attack)
        }
        
        // End attack after duration
        if (attackElapsed >= this.attackDuration) {
          this.isAttacking = false
        }
      }
      
      // Update existing attacks
      for (let i = this.attacks.length - 1; i >= 0; i--) {
        const attack = this.attacks[i]
        attack.update({ dt, camera })
        if (!attack.alive) {
          attack.dispose()
          this.attacks.splice(i, 1)
        }
      }
    }

    // Billboard: face the camera but stay perpendicular to ground
    this.cameraPos.copy(camera.position)
    this.cameraPos.y = pos.y // Lock to same Y level
    this.mesh.lookAt(this.cameraPos)

    // Sprite animation
    if (this.spriteReady) {
      if (this.state === 'pursuing') {
        const frame = Math.floor(this.pursuitAnimTime * this.pursuitFPS) % this.pursuitFrameCount
        this.renderSpriteFrame(frame)
      } else if (this.state === 'dying' || this.state === 'dead') {
        const last = this.deathStartFrame + (this.deathFrameCount - 1)
        const frameOffset = Math.min(this.deathFrameCount - 1, Math.floor(this.deathAnimTime * this.deathFPS))
        const frame = this.deathStartFrame + frameOffset
        this.renderSpriteFrame(frame)

        if (this.state === 'dying') {
          this.deathAnimTime += dt
          if (frame >= last) {
            this.state = 'dead'
            // Let the last frame render once, then disappear.
            this.hideOnNextUpdate = true
            this.spawnExplosionEvent = true
          }
        }
      } else {
        this.renderSpriteFrame(0)
      }
    } else {
      // Re-render the animated checkerboard while sprites load
      this.renderCheckerboard()
    }
  }

  dispose(): void {
    this.texture.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.geometry.dispose()
    
    // Dispose of all attacks
    for (const attack of this.attacks) {
      attack.dispose()
    }
  }
}
