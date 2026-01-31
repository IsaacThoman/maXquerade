import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'

type BaseOverlayWorldOptions = {
  aspect: number
  baseImageSrc?: string
  animImageSrc?: string
}

export class BaseOverlayWorld {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  private planeGeometry: THREE.PlaneGeometry
  private planeMaterial: THREE.MeshBasicMaterial
  private plane: THREE.Mesh

  private texture: THREE.CanvasTexture | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private baseImage: HTMLImageElement | null = null
  private anim: SpriteSheet | null = null

  private animX = 0
  private animY = 0
  private animScale = 1
  private animFrame = 0
  private animTimer = 0
  private readonly animFps = 8

  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private yaw = 0
  private pitch = 0
  private disposed = false

  constructor({ aspect, baseImageSrc = '/sprites/mask0.png', animImageSrc = '/sprites/mask1.png' }: BaseOverlayWorldOptions) {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 50)
    this.camera.position.set(0, 0, 2.4)

    this.planeGeometry = new THREE.PlaneGeometry(1, 1)
    this.planeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    this.plane = new THREE.Mesh(this.planeGeometry, this.planeMaterial)
    this.scene.add(this.plane)

    this.updateCamera()
    this.loadAssets(baseImageSrc, animImageSrc)
  }

  update(dt: number): void {
    if (!this.canvas || !this.ctx || !this.baseImage || !this.anim || !this.texture) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(this.baseImage, 0, 0)
    if (this.anim.frameCount > 1 && this.animFps > 0) {
      const frameDuration = 1 / this.animFps
      this.animTimer += dt
      while (this.animTimer >= frameDuration) {
        this.animTimer -= frameDuration
        this.animFrame = (this.animFrame + 1) % this.anim.frameCount
      }
    }
    this.anim.drawFrame(this.ctx, this.animFrame, this.animX, this.animY, this.animScale)
    this.texture.needsUpdate = true
  }

  handleMouseMove(event: MouseEvent, allowRotation: boolean): void {
    if (!allowRotation) return
    const movementX = event.movementX || 0
    const movementY = event.movementY || 0
    const sensitivity = 0.0025

    this.yaw -= movementX * sensitivity
    this.pitch -= movementY * sensitivity

    const maxPitch = Math.PI * 0.49
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch))
    this.updateCamera()
  }

  onResize(width: number, height: number): void {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    this.disposed = true
    this.texture?.dispose()
    this.planeMaterial.dispose()
    this.planeGeometry.dispose()
  }

  private updateCamera(): void {
    this.euler.set(this.pitch, this.yaw, 0)
    this.camera.quaternion.setFromEuler(this.euler)
  }

  private loadAssets(baseImageSrc: string, animImageSrc: string): void {
    Promise.all([this.loadImage(baseImageSrc), this.loadImage(animImageSrc)])
      .then(([baseImage, animImage]) => {
        if (this.disposed) return
        this.baseImage = baseImage
        this.canvas = document.createElement('canvas')
        this.canvas.width = baseImage.width
        this.canvas.height = baseImage.height
        this.ctx = this.canvas.getContext('2d')
        if (!this.ctx) return
        this.ctx.imageSmoothingEnabled = false

        this.texture = new THREE.CanvasTexture(this.canvas)
        this.texture.magFilter = THREE.NearestFilter
        this.texture.minFilter = THREE.NearestFilter
        this.texture.generateMipmaps = false

        this.planeMaterial.map = this.texture
        this.planeMaterial.needsUpdate = true

        const aspect = this.canvas.width / this.canvas.height
        this.plane.scale.set(aspect, 1, 1)

        this.anim = new SpriteSheet(animImage, 64, 48, {
          frameCount: 4,
          framesPerRow: 1,
        })

        this.animX = Math.floor((this.canvas.width - this.anim.frameWidth * this.animScale) / 2)
        this.animY = Math.floor((this.canvas.height - this.anim.frameHeight * this.animScale) / 2)

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
