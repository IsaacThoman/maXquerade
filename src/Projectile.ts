import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'
import { setRaycasterFirstHitOnly } from './bvh'

export type BillboardMode = 'upright' | 'full' | 'none'

export type ProjectileOptions = {
  spriteSrc: string
  frameWidth: number
  frameHeight: number
  frameCount: number
  framesPerRow: number
  fps?: number
  size?: number
  billboard?: BillboardMode
  alphaTest?: number
  gravity?: number
  drag?: number
  lifetimeSeconds?: number
  collisionRadius?: number
  collisionEpsilon?: number
  collideWithWorld?: boolean
  startSize?: number
  sizeTransitionDuration?: number
  targetSize?: number
  bounceRestitution?: number
  maxBounces?: number
}

type ProjectileUpdateParams = {
  dt: number
  camera: THREE.Camera
  collisionMeshes?: THREE.Mesh[]
}

const imageCache = new Map<string, Promise<HTMLImageElement>>()

const loadImageCached = (src: string): Promise<HTMLImageElement> => {
  const existing = imageCache.get(src)
  if (existing) return existing

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
    img.src = src
  })

  imageCache.set(src, promise)
  return promise
}

export class Projectile {
  readonly mesh: THREE.Mesh
  readonly velocity = new THREE.Vector3()

  alive = true
  ageSeconds = 0

  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly texture: THREE.CanvasTexture
  private readonly options: Required<ProjectileOptions>

  private bounceCount = 0

  private sheet: SpriteSheet | null = null
  private spriteReady = false
  private lastDrawnFrame = -1

  private readonly cameraPos = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private readonly rayOrigin = new THREE.Vector3()
  private readonly rayDir = new THREE.Vector3()
  private readonly hits: THREE.Intersection[] = []
  private readonly hitNormal = new THREE.Vector3()
  private readonly normalMatrix = new THREE.Matrix3()

  private readonly startSize: number
  private readonly targetSize: number
  private readonly sizeTransitionDuration: number
  private currentSize: number

  constructor(position: THREE.Vector3, velocity: THREE.Vector3, options: ProjectileOptions) {
    this.options = {
      fps: 12,
      size: 0.6,
      billboard: 'upright',
      alphaTest: 0.35,
      gravity: 0,
      drag: 0,
      lifetimeSeconds: 2.0,
      collisionRadius: 0.15,
      collisionEpsilon: 0.002,
      collideWithWorld: true,
      bounceRestitution: 0,
      maxBounces: 0,
      startSize: options.size || 0.6,
      targetSize: options.size || 0.6,
      sizeTransitionDuration: 0.15,
      ...options,
    }

    this.velocity.copy(velocity)

    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.max(1, Math.floor(this.options.frameWidth))
    this.canvas.height = Math.max(1, Math.floor(this.options.frameHeight))

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to create 2D context')
    this.ctx = ctx
    this.ctx.imageSmoothingEnabled = false

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false

    const aspect = this.options.frameWidth / this.options.frameHeight
    const h = this.options.size
    const w = h * aspect
    const geometry = new THREE.PlaneGeometry(w, h)
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: this.options.alphaTest,
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.position.copy(position)

    // Initialize size transition properties
    this.startSize = this.options.startSize
    this.targetSize = this.options.targetSize
    this.sizeTransitionDuration = this.options.sizeTransitionDuration
    this.currentSize = this.startSize

    setRaycasterFirstHitOnly(this.raycaster, true)

    this.renderPlaceholder()
    void this.loadSpriteSheet()
  }

  get collisionRadius(): number {
    return this.options.collisionRadius
  }

  update({ dt, camera, collisionMeshes }: ProjectileUpdateParams): void {
    if (!this.alive) return

    this.ageSeconds += dt
    if (this.options.lifetimeSeconds > 0 && this.ageSeconds >= this.options.lifetimeSeconds) {
      this.alive = false
      return
    }

    // Physics (integrate; collision assumes constant velocity during dt)
    if (this.options.gravity !== 0) this.velocity.y -= this.options.gravity * dt
    if (this.options.drag > 0) this.velocity.multiplyScalar(Math.exp(-this.options.drag * dt))

    const pos = this.mesh.position

    // World collision sweep + bounce (iterative so we don't tunnel or double-apply motion)
    let remaining = dt
    let iterations = 0
    const maxIterations = 6

    const canCollide = this.options.collideWithWorld && collisionMeshes && collisionMeshes.length > 0
    while (remaining > 1e-6 && iterations++ < maxIterations) {
      const dx = this.velocity.x * remaining
      const dy = this.velocity.y * remaining
      const dz = this.velocity.z * remaining
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (!canCollide || dist <= 1e-6) {
        pos.x += dx
        pos.y += dy
        pos.z += dz
        break
      }

      this.rayOrigin.copy(pos)
      this.rayDir.set(dx / dist, dy / dist, dz / dist)
      this.raycaster.set(this.rayOrigin, this.rayDir)
      this.raycaster.far = dist + this.options.collisionRadius
      this.hits.length = 0
      this.raycaster.intersectObjects(collisionMeshes!, false, this.hits)

      if (this.hits.length === 0) {
        pos.x += dx
        pos.y += dy
        pos.z += dz
        break
      }

      const hit = this.hits[0]
      const travelDist = Math.max(0, hit.distance - this.options.collisionRadius)
      pos.addScaledVector(this.rayDir, travelDist)

      const tHit = dist > 0 ? (travelDist / dist) * remaining : 0
      remaining = Math.max(0, remaining - tHit)

      if (!(this.options.bounceRestitution > 0) || !this.tryGetWorldNormal(hit, this.hitNormal)) {
        this.alive = false
        return
      }

      // Nudge off the surface to avoid immediate re-hit.
      pos.addScaledVector(this.hitNormal, this.options.collisionEpsilon)

      // Reflect velocity around the hit normal.
      const vn = this.velocity.dot(this.hitNormal)
      if (vn < 0) this.velocity.addScaledVector(this.hitNormal, -2 * vn)
      this.velocity.multiplyScalar(this.options.bounceRestitution)

      this.bounceCount++
      if (this.options.maxBounces > 0 && this.bounceCount > this.options.maxBounces) {
        this.alive = false
        return
      }

      // Ensure we make progress even on near-zero distance hits.
      remaining = Math.max(0, remaining - 1e-5)
    }

    // Billboard
    if (this.options.billboard !== 'none') {
      this.cameraPos.copy(camera.position)
      if (this.options.billboard === 'upright') this.cameraPos.y = pos.y
      this.mesh.lookAt(this.cameraPos)
    }

    // Size transition
    if (this.ageSeconds < this.sizeTransitionDuration) {
      const t = this.ageSeconds / this.sizeTransitionDuration
      this.currentSize = THREE.MathUtils.lerp(this.startSize, this.targetSize, t)
    } else {
      this.currentSize = this.targetSize
    }

    // Update mesh scale based on current size
    const aspect = this.options.frameWidth / this.options.frameHeight
    const h = this.currentSize
    const w = h * aspect
    this.mesh.scale.set(w / this.options.size, h / this.options.size, 1)

    // Animation
    if (this.spriteReady && this.sheet) {
      const frame = this.options.fps <= 0 ? 0 : Math.floor(this.ageSeconds * this.options.fps) % this.options.frameCount
      this.drawFrame(frame)
    }
  }

  dispose(): void {
    this.texture.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.geometry.dispose()
  }

  private async loadSpriteSheet(): Promise<void> {
    try {
      const img = await loadImageCached(this.options.spriteSrc)
      this.sheet = new SpriteSheet(img, this.options.frameWidth, this.options.frameHeight, {
        frameCount: this.options.frameCount,
        framesPerRow: this.options.framesPerRow,
      })
      this.spriteReady = true
      this.drawFrame(0)
    } catch {
      // Keep placeholder if sprite load fails.
    }
  }

  private drawFrame(frame: number): void {
    if (!this.sheet) return
    if (frame === this.lastDrawnFrame) return

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.sheet.drawFrame(this.ctx, frame, 0, 0, 1)
    this.lastDrawnFrame = frame
    this.texture.needsUpdate = true
  }

  private tryGetWorldNormal(hit: THREE.Intersection, out: THREE.Vector3): boolean {
    const faceNormal = hit.face?.normal
    if (!faceNormal) return false

    out.copy(faceNormal)
    this.normalMatrix.getNormalMatrix(hit.object.matrixWorld)
    out.applyMatrix3(this.normalMatrix).normalize()

    // Ensure the normal opposes motion (handles backface hits).
    if (out.dot(this.rayDir) > 0) out.negate()
    return out.lengthSq() > 0
  }

  private renderPlaceholder(): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.fillStyle = '#ff00ff'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.fillStyle = '#000000'
    ctx.fillRect(1, 1, this.canvas.width - 2, this.canvas.height - 2)
    this.texture.needsUpdate = true
  }
}
