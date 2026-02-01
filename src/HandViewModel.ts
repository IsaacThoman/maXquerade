import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'

type HandViewModelOptions = {
  aspect: number
  imageSrc?: string
  idleFps?: number
  throwFps?: number
}

type AnimState = 'idle' | 'throw'

export class HandViewModel {
  readonly scene: THREE.Scene
  readonly camera: THREE.OrthographicCamera

  idleFps: number
  throwFps: number

  private planeGeometry: THREE.PlaneGeometry
  private planeMaterial: THREE.MeshBasicMaterial
  private plane: THREE.Mesh

  private texture: THREE.CanvasTexture | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private sheet: SpriteSheet | null = null

  private state: AnimState = 'idle'
  // Track animation progress in "frames" so changing fps mid-stream doesn't jump phase.
  private idleFrameTime = 0
  private throwFrameTime = 0
  private frame = 0

  private disposed = false

  // Sprite layout: 5 columns x 2 rows (top row: 2 idle frames, bottom row: 5 throw frames)
  private readonly columns = 5
  private readonly rows = 2
  private readonly idleFrames = [0, 1]
  private readonly throwFrames = [5, 6, 7, 8, 9]

  // Preferred per-frame pixel size (32x48 for 160x96 sprite sheet)
  // Falls back to calculated values if sheet doesn't match
  private readonly preferredFrameWidth = 32
  private readonly preferredFrameHeight = 48

  // Placement in orthographic view space
  private readonly viewHeight = 1.56
  private readonly bottomMargin = 0
  private readonly rightMargin = 0
  private spriteAspect = 1

  constructor({ aspect, imageSrc = 'sprites/hand.png', idleFps = 12, throwFps = 12 }: HandViewModelOptions) {
    this.idleFps = idleFps
    this.throwFps = throwFps

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10)
    this.camera.position.set(0, 0, 1)

    this.planeGeometry = new THREE.PlaneGeometry(1, 1)
    this.planeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    this.plane = new THREE.Mesh(this.planeGeometry, this.planeMaterial)
    this.scene.add(this.plane)

    this.updatePlacement()
    this.loadAssets(imageSrc)
  }

  triggerThrow(): void {
    this.state = 'throw'
    this.throwFrameTime = 0
  }

  update(dt: number): void {
    this.frame = this.computeFrame(dt)
    if (!this.canvas || !this.ctx || !this.sheet || !this.texture) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.sheet.drawFrame(this.ctx, this.frame, 0, 0, 1)
    this.texture.needsUpdate = true
  }

  onResize(width: number, height: number): void {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    const aspect = w / h
    this.camera.left = -aspect
    this.camera.right = aspect
    this.camera.top = 1
    this.camera.bottom = -1
    this.camera.updateProjectionMatrix()
    this.updatePlacement()
  }

  dispose(): void {
    this.disposed = true
    this.texture?.dispose()
    this.planeMaterial.dispose()
    this.planeGeometry.dispose()
  }

  private computeFrame(dt: number): number {
    if (this.state === 'throw') {
      if (this.throwFps <= 0) return this.throwFrames[0]
      this.throwFrameTime += dt * this.throwFps
      const idx = Math.floor(this.throwFrameTime)
      if (idx >= this.throwFrames.length) {
        this.state = 'idle'
        this.idleFrameTime = 0
        return this.idleFrames[0]
      }
      return this.throwFrames[Math.max(0, idx)]
    }

    if (this.idleFps <= 0) return this.idleFrames[0]
    this.idleFrameTime += dt * this.idleFps
    const idx = Math.floor(this.idleFrameTime) % this.idleFrames.length
    return this.idleFrames[idx]
  }

  private updatePlacement(): void {
    const h = this.viewHeight
    const w = h * this.spriteAspect
    this.plane.scale.set(w, h, 1)
    const rightEdge = this.camera.right
    this.plane.position.set(rightEdge - w / 2 - this.rightMargin, -1 + h / 2 + this.bottomMargin, 0)
  }

  private loadAssets(imageSrc: string): void {
    this.loadImage(imageSrc)
      .then((img) => {
        if (this.disposed) return

        const divisible = img.width % this.columns === 0 && img.height % this.rows === 0
        const preferredFits =
          img.width >= this.preferredFrameWidth * this.columns && img.height >= this.preferredFrameHeight * this.rows

        const frameWidth =
          divisible ? Math.floor(img.width / this.columns) : preferredFits ? this.preferredFrameWidth : Math.max(1, Math.floor(img.width / this.columns))
        const frameHeight =
          divisible ? Math.floor(img.height / this.rows) : preferredFits ? this.preferredFrameHeight : Math.max(1, Math.floor(img.height / this.rows))

        if (!divisible) {
          console.warn(
            `[HandViewModel] hand sheet size (${img.width}x${img.height}) not divisible by ${this.columns}x${this.rows}; expected ${this.columns * this.preferredFrameWidth}x${this.rows * this.preferredFrameHeight}. Using frame ${frameWidth}x${frameHeight}`,
          )
        }

        this.spriteAspect = frameWidth / frameHeight
        this.updatePlacement()

        this.canvas = document.createElement('canvas')
        this.canvas.width = frameWidth
        this.canvas.height = frameHeight
        this.ctx = this.canvas.getContext('2d')
        if (!this.ctx) return
        this.ctx.imageSmoothingEnabled = false

        this.texture = new THREE.CanvasTexture(this.canvas)
        this.texture.magFilter = THREE.NearestFilter
        this.texture.minFilter = THREE.NearestFilter
        this.texture.generateMipmaps = false

        this.planeMaterial.map = this.texture
        this.planeMaterial.needsUpdate = true

        this.sheet = new SpriteSheet(img, frameWidth, frameHeight, {
          frameCount: this.columns * this.rows,
          framesPerRow: this.columns,
        })

        this.update(0)
      })
      .catch((error) => {
        console.error(error)
      })
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
      img.src = src
    })
  }
}
