import * as THREE from 'three'

export type EnemyState = 'idle' | 'pursuing'

export interface EnemyUpdateParams {
  dt: number
  camera: THREE.Camera
  playerPosition: THREE.Vector3
  collisionMeshes: THREE.Mesh[]
}

export class Enemy {
  readonly mesh: THREE.Mesh
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private time: number = 0

  // Internal resolution
  private readonly width = 16
  private readonly height = 32

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

  // Reusable vectors for performance
  private readonly rayOrigin = new THREE.Vector3()
  private readonly rayDir = new THREE.Vector3()
  private readonly groundRaycaster = new THREE.Raycaster()
  private readonly wallRaycaster = new THREE.Raycaster()

  constructor(position: THREE.Vector3, state: EnemyState = 'idle') {
    // Create offscreen canvas at internal resolution
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.width
    this.canvas.height = this.height
    this.ctx = this.canvas.getContext('2d')!

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
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.position.copy(position)

    this.state = state

    // Setup raycasters
    this.groundRaycaster.far = this.enemyHeight + 0.5
    this.wallRaycaster.far = this.enemyRadius + 0.1

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

  private checkGround(pos: THREE.Vector3, collisionMeshes: THREE.Mesh[]): { grounded: boolean; groundY: number } {
    this.rayOrigin.set(pos.x, pos.y, pos.z)
    this.rayDir.set(0, -1, 0)
    this.groundRaycaster.set(this.rayOrigin, this.rayDir)

    // Check map collision
    if (collisionMeshes.length > 0) {
      const hits = this.groundRaycaster.intersectObjects(collisionMeshes, false)
      if (hits.length > 0) {
        const dist = hits[0].distance
        if (dist <= this.enemyHeight + 0.1) {
          return { grounded: true, groundY: hits[0].point.y }
        }
      }
    }

    return { grounded: false, groundY: 0 }
  }

  private resolveWallCollision(pos: THREE.Vector3, vel: THREE.Vector3, collisionMeshes: THREE.Mesh[]): void {
    if (collisionMeshes.length === 0) return

    // Check 8 directions around enemy
    const directions = [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0.707, 0, 0.707),
      new THREE.Vector3(-0.707, 0, 0.707),
      new THREE.Vector3(0.707, 0, -0.707),
      new THREE.Vector3(-0.707, 0, -0.707),
    ]

    // Check at multiple heights
    const heights = [0.2, this.enemyHeight * 0.5, this.enemyHeight - 0.1]

    for (const height of heights) {
      for (const dir of directions) {
        this.rayOrigin.set(pos.x, pos.y - this.enemyHeight + height, pos.z)
        this.wallRaycaster.set(this.rayOrigin, dir)
        this.wallRaycaster.far = this.enemyRadius + 0.05

        const hits = this.wallRaycaster.intersectObjects(collisionMeshes, false)
        if (hits.length > 0) {
          const hit = hits[0]
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
    if (this.state === 'pursuing') {
      // Move towards player
      const toPlayer = new THREE.Vector3(
        playerPosition.x - pos.x,
        0,
        playerPosition.z - pos.z
      )
      const distance = toPlayer.length()

      if (distance > 1.5) {
        // Don't get too close
        toPlayer.normalize()

        // Accelerate towards player
        if (this.grounded) {
          this.velocity.x = toPlayer.x * this.moveSpeed
          this.velocity.z = toPlayer.z * this.moveSpeed
        } else {
          // Less control in air
          this.velocity.x += toPlayer.x * this.moveSpeed * 0.1 * dt
          this.velocity.z += toPlayer.z * this.moveSpeed * 0.1 * dt
        }
      }
    } else {
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
    const cameraPos = camera.position.clone()
    cameraPos.y = pos.y // Lock to same Y level
    this.mesh.lookAt(cameraPos)

    // Re-render the animated checkerboard
    this.renderCheckerboard()
  }

  dispose(): void {
    this.texture.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.geometry.dispose()
  }
}
