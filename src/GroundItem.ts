import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'

export type GroundItemBillboardMode = 'upright' | 'none'

export type GroundItemOptions = {
  spriteSrc: string
  frameWidth: number
  frameHeight: number
  frameIndex?: number
  frameCount?: number
  framesPerRow?: number
  size?: number
  alphaTest?: number
  billboard?: GroundItemBillboardMode
  bobAmplitude?: number
  bobFrequencyHz?: number
  spinSpeedRadPerSec?: number
}

export type GroundItemUpdateParams = {
  dt: number
  camera: THREE.Camera
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

export class GroundItem {
  readonly mesh: THREE.Group

  private readonly options: Required<GroundItemOptions>
  private readonly basePos = new THREE.Vector3()
  private ageSeconds = 0

  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly texture: THREE.CanvasTexture
  private readonly material: THREE.MeshBasicMaterial
  private readonly geometry: THREE.PlaneGeometry
  private readonly spinGroup: THREE.Group

  private sheet: SpriteSheet | null = null
  private spriteReady = false

  private readonly cameraPos = new THREE.Vector3()

  constructor(position: THREE.Vector3, options: GroundItemOptions) {
    this.options = {
      frameIndex: 0,
      frameCount: 1,
      framesPerRow: 1,
      size: 1.1,
      alphaTest: 0.5,
      billboard: 'upright',
      bobAmplitude: 0.22,
      bobFrequencyHz: 1.2,
      spinSpeedRadPerSec: 2.4,
      ...options,
    }

    this.basePos.copy(position)

    this.mesh = new THREE.Group()
    this.mesh.position.copy(position)

    this.spinGroup = new THREE.Group()
    this.mesh.add(this.spinGroup)

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
    this.geometry = new THREE.PlaneGeometry(w, h)
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: this.options.alphaTest,
      side: THREE.DoubleSide,
    })

    // Crossed planes to keep the sprite visible while spinning.
    const planeA = new THREE.Mesh(this.geometry, this.material)
   // const planeB = new THREE.Mesh(this.geometry, this.material)
   // planeB.rotation.y = Math.PI / 2
    this.spinGroup.add(planeA)

    this.renderPlaceholder()
    void this.loadSpriteSheet()
  }

  update({ dt, camera }: GroundItemUpdateParams): void {
    this.ageSeconds += dt

    // Bobbing
    const w = Math.PI * 2 * this.options.bobFrequencyHz
    this.mesh.position.set(
      this.basePos.x,
      this.basePos.y + Math.sin(this.ageSeconds * w) * this.options.bobAmplitude,
      this.basePos.z,
    )

    // Billboard (root), then spin (child)
    if (this.options.billboard === 'upright') {
      this.cameraPos.copy(camera.position)
      this.cameraPos.y = this.mesh.position.y
      this.mesh.lookAt(this.cameraPos)
    }

    this.spinGroup.rotation.y += this.options.spinSpeedRadPerSec * dt
  }

  dispose(): void {
    this.texture.dispose()
    this.material.dispose()
    this.geometry.dispose()
  }

  private async loadSpriteSheet(): Promise<void> {
    try {
      const img = await loadImageCached(this.options.spriteSrc)
      this.sheet = new SpriteSheet(img, this.options.frameWidth, this.options.frameHeight, {
        frameCount: this.options.frameCount,
        framesPerRow: this.options.framesPerRow,
      })
      this.spriteReady = true
      this.drawFrame(this.options.frameIndex)
    } catch {
      // Keep placeholder if sprite load fails.
    }
  }

  private drawFrame(frameIndex: number): void {
    if (!this.spriteReady || !this.sheet) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.sheet.drawFrame(this.ctx, frameIndex, 0, 0, 1)
    this.texture.needsUpdate = true
  }

  private renderPlaceholder(): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.texture.needsUpdate = true
  }
}
