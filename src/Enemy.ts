import * as THREE from 'three'
import { initThreeMeshBVH, setRaycasterFirstHitOnly } from './bvh'

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

  constructor(position: THREE.Vector3, state: EnemyState = 'idle', type: EnemyType = 0) {
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

    if (this.type === 0) {
      this.state = 'dying'
      this.deathAnimTime = 0
      this.hideOnNextUpdate = false
      this.spawnExplosionEvent = false
      this.lastDrawnFrame = -1
      return
    }

    // Other enemy types: disappear for now.
    this.state = 'dead'
    this.mesh.visible = false
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

    // State-based behavior
    if (this.state === 'pursuing' && this.alive) {
      this.pursuitAnimTime += dt
      // Move towards player
      this.toPlayer.set(playerPosition.x - pos.x, 0, playerPosition.z - pos.z)
      const distance = this.toPlayer.length()

      if (distance > 1.5) {
        // Don't get too close
        this.toPlayer.normalize()

        // Accelerate towards player
        if (this.grounded) {
          this.velocity.x = this.toPlayer.x * this.moveSpeed
          this.velocity.z = this.toPlayer.z * this.moveSpeed
        } else {
          // Less control in air
          this.velocity.x += this.toPlayer.x * this.moveSpeed * 0.1 * dt
          this.velocity.z += this.toPlayer.z * this.moveSpeed * 0.1 * dt
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
  }
}
