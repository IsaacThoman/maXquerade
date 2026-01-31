import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'

type BaseOverlayWorldOptions = {
  aspect: number
  baseImageSrc?: string
  animImageSrc?: string
  alphaMaskSrc?: string
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

  // Alpha mask for enemy visibility (eye holes)
  readonly alphaMaskScene: THREE.Scene
  readonly alphaMaskCamera: THREE.PerspectiveCamera
  private alphaMaskPlane: THREE.Mesh
  private alphaMaskGeometry: THREE.PlaneGeometry
  private alphaMaskMaterial: THREE.MeshBasicMaterial
  private alphaMaskTexture: THREE.CanvasTexture | null = null
  private alphaMaskCanvas: HTMLCanvasElement | null = null
  private alphaMaskCtx: CanvasRenderingContext2D | null = null
  private alphaMaskAnim: SpriteSheet | null = null

  private animX = 0
  private animY = 0
  private animScale = 1
  private animFrame = 0
  private animTimer = 0
  private readonly animFps = 14

  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private yaw = 0
  private pitch = 0
  private readonly maxPitch = Math.PI * 0.49
  private disposed = false

  private readonly aimAssistTargets: THREE.Object3D[] = []
  private readonly aimAssistCameraPos = new THREE.Vector3()
  private readonly aimAssistTargetPos = new THREE.Vector3()
  private readonly aimAssistForward = new THREE.Vector3()
  private readonly aimAssistDir = new THREE.Vector3()
  private readonly aimAssistBestDir = new THREE.Vector3()
  private readonly aimAssistQuat = new THREE.Quaternion()
  private readonly aimAssistEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  private readonly aimAssistBaseForward = new THREE.Vector3(0, 0, -1)
  private readonly aimAssistRaycaster = new THREE.Raycaster()
  private readonly aimAssistRayHits: THREE.Intersection[] = []
  private readonly aimAssistDamping = 6
  private readonly aimAssistMaxAngle = Math.PI

  constructor({ aspect, baseImageSrc = '/sprites/mask0.png', animImageSrc = '/sprites/mask1.png', alphaMaskSrc = '/sprites/mask0_alpha.png' }: BaseOverlayWorldOptions) {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(90, aspect, 0.1, 50)
    this.camera.position.set(0, 0, 0.4)

    this.planeGeometry = new THREE.PlaneGeometry(1, 1)
    this.planeMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    this.plane = new THREE.Mesh(this.planeGeometry, this.planeMaterial)
    this.scene.add(this.plane)

    // Alpha mask scene (for stencil-based enemy visibility through eye holes)
    this.alphaMaskScene = new THREE.Scene()
    this.alphaMaskCamera = new THREE.PerspectiveCamera(90, aspect, 0.1, 50)
    this.alphaMaskCamera.position.set(0, 0, 0.4)
    
    this.alphaMaskGeometry = new THREE.PlaneGeometry(1, 1)
    this.alphaMaskMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.5, // Only draw (and write to stencil) where alpha > 0.5
    })
    this.alphaMaskPlane = new THREE.Mesh(this.alphaMaskGeometry, this.alphaMaskMaterial)
    this.alphaMaskScene.add(this.alphaMaskPlane)

    this.updateCamera()
    this.loadAssets(baseImageSrc, animImageSrc, alphaMaskSrc)
  }

  update(dt: number, aimAssistActive = false): void {
    const isLookingAtCanvas = aimAssistActive ? this.applyAimAssist(dt) : false
    if (!this.canvas || !this.ctx || !this.baseImage || !this.anim || !this.texture) return
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    //this.ctx.drawImage(this.baseImage, 0, 0)
    const targetFrame = isLookingAtCanvas ? this.anim.frameCount - 1 : 0
    this.updateAnimFrame(dt, targetFrame)
    this.anim.drawFrame(this.ctx, this.animFrame, this.animX, this.animY, this.animScale)
    this.texture.needsUpdate = true

    // Update alpha mask in sync with main mask
    if (this.alphaMaskCanvas && this.alphaMaskCtx && this.alphaMaskAnim && this.alphaMaskTexture) {
      this.alphaMaskCtx.clearRect(0, 0, this.alphaMaskCanvas.width, this.alphaMaskCanvas.height)
      this.alphaMaskAnim.drawFrame(this.alphaMaskCtx, this.animFrame, this.animX, this.animY, this.animScale)
      this.alphaMaskTexture.needsUpdate = true
    }
  }

  handleMouseMove(event: MouseEvent, allowRotation: boolean): void {
    if (!allowRotation) return
    const movementX = event.movementX || 0
    const movementY = event.movementY || 0
    const sensitivity = 0.0025

    this.yaw -= movementX * sensitivity
    this.pitch -= movementY * sensitivity

    this.pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.pitch))
    this.updateCamera()
  }

  onResize(width: number, height: number): void {
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.alphaMaskCamera.aspect = w / h
    this.alphaMaskCamera.updateProjectionMatrix()
  }

  dispose(): void {
    this.disposed = true
    this.texture?.dispose()
    this.planeMaterial.dispose()
    this.planeGeometry.dispose()
    this.alphaMaskTexture?.dispose()
    this.alphaMaskMaterial.dispose()
    this.alphaMaskGeometry.dispose()
  }

  private updateCamera(): void {
    this.euler.set(this.pitch, this.yaw, 0)
    this.camera.quaternion.setFromEuler(this.euler)
    // Keep alpha mask camera in sync
    this.alphaMaskCamera.quaternion.setFromEuler(this.euler)
  }

  private applyAimAssist(dt: number): boolean {
    this.collectCanvasTargets()
    if (this.aimAssistTargets.length === 0) return false

    this.camera.getWorldPosition(this.aimAssistCameraPos)
    this.camera.getWorldDirection(this.aimAssistForward)

    this.aimAssistRaycaster.set(this.aimAssistCameraPos, this.aimAssistForward)
    this.aimAssistRayHits.length = 0
    const hits = this.aimAssistRaycaster.intersectObjects(this.aimAssistTargets, false, this.aimAssistRayHits)
    if (hits.length === 0) return false

    const hitObject = hits[0].object
    if (!hitObject.visible) return false

    hitObject.getWorldPosition(this.aimAssistTargetPos)
    this.aimAssistDir.subVectors(this.aimAssistTargetPos, this.aimAssistCameraPos)
    if (this.aimAssistDir.lengthSq() <= 0) return false
    this.aimAssistDir.normalize()

    const dot = this.aimAssistForward.dot(this.aimAssistDir)
    const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1))
    if (angle > this.aimAssistMaxAngle) return false

    this.aimAssistBestDir.copy(this.aimAssistDir)

    this.aimAssistQuat.setFromUnitVectors(this.aimAssistBaseForward, this.aimAssistBestDir)
    this.aimAssistEuler.setFromQuaternion(this.aimAssistQuat, 'YXZ')

    const targetPitch = this.aimAssistEuler.x
    const targetYaw = this.aimAssistEuler.y
    const t = 1 - Math.exp(-this.aimAssistDamping * dt)

    this.pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.lerpAngle(this.pitch, targetPitch, t)))
    this.yaw = this.lerpAngle(this.yaw, targetYaw, t)
    this.updateCamera()
    return true
  }

  private updateAnimFrame(dt: number, targetFrame: number): void {
    if (this.animFps <= 0 || this.animFrame === targetFrame) return
    const frameDuration = 1 / this.animFps
    this.animTimer += dt
    while (this.animTimer >= frameDuration) {
      this.animTimer -= frameDuration
      if (this.animFrame < targetFrame) {
        this.animFrame += 1
      } else if (this.animFrame > targetFrame) {
        this.animFrame -= 1
      } else {
        break
      }
    }
  }

  private collectCanvasTargets(): void {
    this.aimAssistTargets.length = 0
    this.scene.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return
      const mesh = child as THREE.Mesh
      if (!this.meshHasCanvasTexture(mesh)) return
      this.aimAssistTargets.push(mesh)
    })
  }

  private meshHasCanvasTexture(mesh: THREE.Mesh): boolean {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material) continue
      const mat = material as THREE.MeshBasicMaterial
      if ('map' in mat && mat.map instanceof THREE.CanvasTexture) {
        return true
      }
    }
    return false
  }

  private lerpAngle(current: number, target: number, t: number): number {
    const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI
    return current + delta * t
  }

  private loadAssets(baseImageSrc: string, animImageSrc: string, alphaMaskSrc: string): void {
    Promise.all([this.loadImage(baseImageSrc), this.loadImage(animImageSrc), this.loadImage(alphaMaskSrc)])
      .then(([baseImage, animImage, alphaMaskImage]) => {
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

        // Setup alpha mask canvas and texture (same dimensions as main)
        this.alphaMaskCanvas = document.createElement('canvas')
        this.alphaMaskCanvas.width = baseImage.width
        this.alphaMaskCanvas.height = baseImage.height
        this.alphaMaskCtx = this.alphaMaskCanvas.getContext('2d')
        if (!this.alphaMaskCtx) return
        this.alphaMaskCtx.imageSmoothingEnabled = false

        this.alphaMaskTexture = new THREE.CanvasTexture(this.alphaMaskCanvas)
        this.alphaMaskTexture.magFilter = THREE.NearestFilter
        this.alphaMaskTexture.minFilter = THREE.NearestFilter
        this.alphaMaskTexture.generateMipmaps = false

        this.alphaMaskMaterial.map = this.alphaMaskTexture
        this.alphaMaskMaterial.needsUpdate = true
        this.alphaMaskPlane.scale.set(aspect, 1, 1)

        this.alphaMaskAnim = new SpriteSheet(alphaMaskImage, 64, 48, {
          frameCount: 4,
          framesPerRow: 1,
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
