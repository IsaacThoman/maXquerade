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
  collideWithWorld?: boolean
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

  private sheet: SpriteSheet | null = null
  private spriteReady = false
  private lastDrawnFrame = -1

  private readonly cameraPos = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private readonly rayOrigin = new THREE.Vector3()
  private readonly rayDir = new THREE.Vector3()
  private readonly hits: THREE.Intersection[] = []

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
      collideWithWorld: true,
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

    setRaycasterFirstHitOnly(this.raycaster, true)

    this.renderPlaceholder()
    void this.loadSpriteSheet()
  }

  update({ dt, camera, collisionMeshes }: ProjectileUpdateParams): void {
    if (!this.alive) return

    this.ageSeconds += dt
    if (this.options.lifetimeSeconds > 0 && this.ageSeconds >= this.options.lifetimeSeconds) {
      this.alive = false
      return
    }

    // Physics
    if (this.options.gravity !== 0) {
      this.velocity.y -= this.options.gravity * dt
    }
    if (this.options.drag > 0) {
      const decay = Math.exp(-this.options.drag * dt)
      this.velocity.multiplyScalar(decay)
    }

    const pos = this.mesh.position
    const dx = this.velocity.x * dt
    const dy = this.velocity.y * dt
    const dz = this.velocity.z * dt

    // Optional world collision (segment raycast)
    if (this.options.collideWithWorld && collisionMeshes && collisionMeshes.length > 0) {
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist > 1e-6) {
        this.rayOrigin.copy(pos)
        this.rayDir.set(dx / dist, dy / dist, dz / dist)
        this.raycaster.set(this.rayOrigin, this.rayDir)
        this.raycaster.far = dist + this.options.collisionRadius
        this.hits.length = 0
        this.raycaster.intersectObjects(collisionMeshes, false, this.hits)

        if (this.hits.length > 0) {
          const hit = this.hits[0]
          const stopDist = Math.max(0, hit.distance - this.options.collisionRadius)
          pos.addScaledVector(this.rayDir, stopDist)
          this.alive = false
          return
        }
      }
    }

    pos.x += dx
    pos.y += dy
    pos.z += dz

    // Billboard
    if (this.options.billboard !== 'none') {
      this.cameraPos.copy(camera.position)
      if (this.options.billboard === 'upright') this.cameraPos.y = pos.y
      this.mesh.lookAt(this.cameraPos)
    }

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
