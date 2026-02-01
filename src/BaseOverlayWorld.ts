import * as THREE from 'three'
import { SpriteSheet } from './SpriteSheet'

type BaseOverlayWorldOptions = {
  aspect: number
  animImageSrc?: string
  alphaMaskSrc?: string
}

export class BaseOverlayWorld {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  private mask0Enabled = false
  private mask1Enabled = false

  // Mask 0 (item 0)
  private planeGeometry: THREE.PlaneGeometry
  private planeMaterial: THREE.MeshBasicMaterial
  private plane: THREE.Mesh

  private texture: THREE.CanvasTexture | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private anim: SpriteSheet | null = null

  private mask0AnimX = 0
  private mask0AnimY = 0

  // Alpha mask for enemy visibility (eye holes) - mask 0
  readonly alphaMaskScene: THREE.Scene
  readonly alphaMaskCamera: THREE.PerspectiveCamera
  private alphaMaskPlane: THREE.Mesh
  private alphaMaskGeometry: THREE.PlaneGeometry
  private alphaMaskMaterial: THREE.MeshBasicMaterial
  private alphaMaskTexture: THREE.CanvasTexture | null = null
  private alphaMaskCanvas: HTMLCanvasElement | null = null
  private alphaMaskCtx: CanvasRenderingContext2D | null = null
  private alphaMaskAnim: SpriteSheet | null = null

  // Mask 1 (item 1)
  private plane1Geometry: THREE.PlaneGeometry
  private plane1Material: THREE.MeshBasicMaterial
  private plane1: THREE.Mesh
  private texture1: THREE.CanvasTexture | null = null
  private canvas1: HTMLCanvasElement | null = null
  private ctx1: CanvasRenderingContext2D | null = null
  private anim1: SpriteSheet | null = null
  private mask1AnimX = 0
  private mask1AnimY = 0

  // Alpha mask - mask 1
  private alphaMaskPlane1: THREE.Mesh
  private alphaMaskGeometry1: THREE.PlaneGeometry
  private alphaMaskMaterial1: THREE.MeshBasicMaterial
  private alphaMaskTexture1: THREE.CanvasTexture | null = null
  private alphaMaskCanvas1: HTMLCanvasElement | null = null
  private alphaMaskCtx1: CanvasRenderingContext2D | null = null
  private alphaMaskAnim1: SpriteSheet | null = null

  private animScale = 1
  private mask0Frame = 0
  private mask0Timer = 0
  private mask1Frame = 0
  private mask1Timer = 0
  private readonly animFps = 14

  private euler = new THREE.Euler(0, 0, 0, 'YXZ')
  private yaw = 0
  private pitch = -Math.PI * 0.45
  private readonly minPitch = -Math.PI * 0.49
  private readonly maxPitch = THREE.MathUtils.degToRad(20)
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

  constructor({
    aspect,
    animImageSrc = '/sprites/mask0_wider.png',
    alphaMaskSrc = '/sprites/mask0_wider_alpha.png',
  }: BaseOverlayWorldOptions) {
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
    this.plane.visible = false
    this.scene.add(this.plane)

    this.plane1Geometry = new THREE.PlaneGeometry(1, 1)
    this.plane1Material = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    })
    this.plane1 = new THREE.Mesh(this.plane1Geometry, this.plane1Material)
    this.plane1.visible = false
    this.scene.add(this.plane1)

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
    this.alphaMaskPlane.visible = false
    this.alphaMaskScene.add(this.alphaMaskPlane)

    this.alphaMaskGeometry1 = new THREE.PlaneGeometry(1, 1)
    this.alphaMaskMaterial1 = new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0.5,
    })
    this.alphaMaskPlane1 = new THREE.Mesh(this.alphaMaskGeometry1, this.alphaMaskMaterial1)
    this.alphaMaskPlane1.visible = false
    this.alphaMaskScene.add(this.alphaMaskPlane1)

    this.positionSecondaryMaskPlanes()
    this.updateCamera()
    this.loadAssets(animImageSrc, alphaMaskSrc)
    this.loadAssetsMask1('/sprites/mask1.png', '/sprites/mask1_alpha.png')
  }

  get isEnabled(): boolean {
    return this.mask0Enabled || this.mask1Enabled
  }

  setEnabled(enabled: boolean): void {
    this.setMask0Enabled(enabled)
  }

  setMask0Enabled(enabled: boolean): void {
    this.mask0Enabled = enabled
    this.updateVisibility()
  }

  setMask1Enabled(enabled: boolean): void {
    this.mask1Enabled = enabled
    this.updateVisibility()
  }

  update(dt: number, aimAssistActive = false): void {
    const aimed = aimAssistActive ? this.applyAimAssist(dt) : null

    const mask0Last = Math.max(0, (this.anim?.frameCount ?? 1) - 1)
    const mask1Last = Math.max(0, (this.anim1?.frameCount ?? 1) - 1)

    const targetMask0 = this.mask0Enabled && aimed === 'mask0' ? mask0Last : 0
    const targetMask1 = this.mask1Enabled && aimed === 'mask1' ? mask1Last : 0

    const r0 = this.updateAnimFrame(dt, this.mask0Frame, this.mask0Timer, targetMask0)
    this.mask0Frame = r0.frame
    this.mask0Timer = r0.timer

    const r1 = this.updateAnimFrame(dt, this.mask1Frame, this.mask1Timer, targetMask1)
    this.mask1Frame = r1.frame
    this.mask1Timer = r1.timer

    if (this.canvas && this.ctx && this.anim && this.texture) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.anim.drawFrame(this.ctx, this.mask0Frame, this.mask0AnimX, this.mask0AnimY, this.animScale)
      this.texture.needsUpdate = true
    }
    if (this.alphaMaskCanvas && this.alphaMaskCtx && this.alphaMaskAnim && this.alphaMaskTexture) {
      this.alphaMaskCtx.clearRect(0, 0, this.alphaMaskCanvas.width, this.alphaMaskCanvas.height)
      this.alphaMaskAnim.drawFrame(this.alphaMaskCtx, this.mask0Frame, this.mask0AnimX, this.mask0AnimY, this.animScale)
      this.alphaMaskTexture.needsUpdate = true
    }

    if (this.canvas1 && this.ctx1 && this.anim1 && this.texture1) {
      this.ctx1.clearRect(0, 0, this.canvas1.width, this.canvas1.height)
      this.anim1.drawFrame(this.ctx1, this.mask1Frame, this.mask1AnimX, this.mask1AnimY, this.animScale)
      this.texture1.needsUpdate = true
    }
    if (this.alphaMaskCanvas1 && this.alphaMaskCtx1 && this.alphaMaskAnim1 && this.alphaMaskTexture1) {
      this.alphaMaskCtx1.clearRect(0, 0, this.alphaMaskCanvas1.width, this.alphaMaskCanvas1.height)
      this.alphaMaskAnim1.drawFrame(this.alphaMaskCtx1, this.mask1Frame, this.mask1AnimX, this.mask1AnimY, this.animScale)
      this.alphaMaskTexture1.needsUpdate = true
    }
  }

  handleMouseMove(event: MouseEvent, allowRotation: boolean): void {
    if (!allowRotation) return
    const movementX = event.movementX || 0
    const movementY = event.movementY || 0
    const sensitivity = 0.0025

    this.yaw += movementX * sensitivity
    this.pitch += movementY * sensitivity

    this.pitch = THREE.MathUtils.clamp(this.pitch, this.minPitch, this.maxPitch)
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

    this.texture1?.dispose()
    this.plane1Material.dispose()
    this.plane1Geometry.dispose()
    this.alphaMaskTexture1?.dispose()
    this.alphaMaskMaterial1.dispose()
    this.alphaMaskGeometry1.dispose()
  }

  private updateCamera(): void {
    this.euler.set(this.pitch, this.yaw, 0)
    this.camera.quaternion.setFromEuler(this.euler)
    // Keep alpha mask camera in sync
    this.alphaMaskCamera.quaternion.setFromEuler(this.euler)
  }

  private applyAimAssist(dt: number): 'mask0' | 'mask1' | null {
    this.collectCanvasTargets()
    if (this.aimAssistTargets.length === 0) return null

    this.camera.getWorldPosition(this.aimAssistCameraPos)
    this.camera.getWorldDirection(this.aimAssistForward)

    this.aimAssistRaycaster.set(this.aimAssistCameraPos, this.aimAssistForward)
    this.aimAssistRayHits.length = 0
    const hits = this.aimAssistRaycaster.intersectObjects(this.aimAssistTargets, false, this.aimAssistRayHits)
    if (hits.length === 0) return null

    const hitObject = hits[0].object
    if (!hitObject.visible) return null

    const aimed = hitObject === this.plane ? 'mask0' : hitObject === this.plane1 ? 'mask1' : null

    hitObject.getWorldPosition(this.aimAssistTargetPos)
    this.aimAssistDir.subVectors(this.aimAssistTargetPos, this.aimAssistCameraPos)
    if (this.aimAssistDir.lengthSq() <= 0) return aimed
    this.aimAssistDir.normalize()

    const dot = this.aimAssistForward.dot(this.aimAssistDir)
    const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1))
    if (angle > this.aimAssistMaxAngle) return aimed

    this.aimAssistBestDir.copy(this.aimAssistDir)

    this.aimAssistQuat.setFromUnitVectors(this.aimAssistBaseForward, this.aimAssistBestDir)
    this.aimAssistEuler.setFromQuaternion(this.aimAssistQuat, 'YXZ')

    const targetPitch = this.aimAssistEuler.x
    const targetYaw = this.aimAssistEuler.y
    const t = 1 - Math.exp(-this.aimAssistDamping * dt)

    this.pitch = THREE.MathUtils.clamp(this.lerpAngle(this.pitch, targetPitch, t), this.minPitch, this.maxPitch)
    this.yaw = this.lerpAngle(this.yaw, targetYaw, t)
    this.updateCamera()
    return aimed
  }

  private updateAnimFrame(
    dt: number,
    currentFrame: number,
    currentTimer: number,
    targetFrame: number,
  ): { frame: number; timer: number } {
    if (this.animFps <= 0 || currentFrame === targetFrame) return { frame: currentFrame, timer: currentTimer }
    const frameDuration = 1 / this.animFps
    let timer = currentTimer + dt
    let frame = currentFrame
    while (timer >= frameDuration) {
      timer -= frameDuration
      if (frame < targetFrame) {
        frame += 1
      } else if (frame > targetFrame) {
        frame -= 1
      } else {
        break
      }
    }
    return { frame, timer }
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

  private loadAssets(animImageSrc: string, alphaMaskSrc: string): void {
    Promise.all([this.loadImage(animImageSrc), this.loadImage(alphaMaskSrc)])
      .then(([animImage, alphaMaskImage]) => {
        if (this.disposed) return

        const frameCount = 4
        const framesPerRow = 1
        const frameWidth = Math.max(1, Math.floor(animImage.width / framesPerRow))
        const frameHeight = Math.max(1, Math.floor(animImage.height / frameCount))
        if (animImage.height % frameCount !== 0) {
          console.warn(
            `[BaseOverlayWorld] animImage height (${animImage.height}) not divisible by frameCount (${frameCount}); using frameHeight=${frameHeight}`,
          )
        }
        if (alphaMaskImage.width !== animImage.width || alphaMaskImage.height !== animImage.height) {
          console.warn(
            `[BaseOverlayWorld] alphaMaskImage size (${alphaMaskImage.width}x${alphaMaskImage.height}) differs from animImage size (${animImage.width}x${animImage.height})`,
          )
        }

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

        const aspect = this.canvas.width / this.canvas.height
        this.plane.scale.set(aspect, 1, 1)

        this.anim = new SpriteSheet(animImage, frameWidth, frameHeight, {
          frameCount,
          framesPerRow,
        })

        this.mask0AnimX = Math.floor((this.canvas.width - this.anim.frameWidth * this.animScale) / 2)
        this.mask0AnimY = Math.floor((this.canvas.height - this.anim.frameHeight * this.animScale) / 2)

        // Setup alpha mask canvas and texture (same dimensions as main)
        this.alphaMaskCanvas = document.createElement('canvas')
        this.alphaMaskCanvas.width = this.canvas.width
        this.alphaMaskCanvas.height = this.canvas.height
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

        this.alphaMaskAnim = new SpriteSheet(alphaMaskImage, frameWidth, frameHeight, {
          frameCount,
          framesPerRow,
        })

        this.update(0)
      })
      .catch((error) => {
        console.error(error)
      })
  }

  private loadAssetsMask1(animImageSrc: string, alphaMaskSrc: string): void {
    Promise.all([this.loadImage(animImageSrc), this.loadImage(alphaMaskSrc)])
      .then(([animImage, alphaMaskImage]) => {
        if (this.disposed) return

        const frameCount = 4
        const framesPerRow = 1
        const frameWidth = Math.max(1, Math.floor(animImage.width / framesPerRow))
        const frameHeight = Math.max(1, Math.floor(animImage.height / frameCount))
        if (animImage.height % frameCount !== 0) {
          console.warn(
            `[BaseOverlayWorld:mask1] animImage height (${animImage.height}) not divisible by frameCount (${frameCount}); using frameHeight=${frameHeight}`,
          )
        }
        if (alphaMaskImage.width !== animImage.width || alphaMaskImage.height !== animImage.height) {
          console.warn(
            `[BaseOverlayWorld:mask1] alphaMaskImage size (${alphaMaskImage.width}x${alphaMaskImage.height}) differs from animImage size (${animImage.width}x${animImage.height})`,
          )
        }

        this.canvas1 = document.createElement('canvas')
        this.canvas1.width = frameWidth
        this.canvas1.height = frameHeight
        this.ctx1 = this.canvas1.getContext('2d')
        if (!this.ctx1) return
        this.ctx1.imageSmoothingEnabled = false

        this.texture1 = new THREE.CanvasTexture(this.canvas1)
        this.texture1.magFilter = THREE.NearestFilter
        this.texture1.minFilter = THREE.NearestFilter
        this.texture1.generateMipmaps = false

        this.plane1Material.map = this.texture1
        this.plane1Material.needsUpdate = true

        const aspect = this.canvas1.width / this.canvas1.height
        this.plane1.scale.set(aspect, 1, 1)

        this.anim1 = new SpriteSheet(animImage, frameWidth, frameHeight, {
          frameCount,
          framesPerRow,
        })

        this.mask1AnimX = Math.floor((this.canvas1.width - this.anim1.frameWidth * this.animScale) / 2)
        this.mask1AnimY = Math.floor((this.canvas1.height - this.anim1.frameHeight * this.animScale) / 2)

        this.alphaMaskCanvas1 = document.createElement('canvas')
        this.alphaMaskCanvas1.width = this.canvas1.width
        this.alphaMaskCanvas1.height = this.canvas1.height
        this.alphaMaskCtx1 = this.alphaMaskCanvas1.getContext('2d')
        if (!this.alphaMaskCtx1) return
        this.alphaMaskCtx1.imageSmoothingEnabled = false

        this.alphaMaskTexture1 = new THREE.CanvasTexture(this.alphaMaskCanvas1)
        this.alphaMaskTexture1.magFilter = THREE.NearestFilter
        this.alphaMaskTexture1.minFilter = THREE.NearestFilter
        this.alphaMaskTexture1.generateMipmaps = false

        this.alphaMaskMaterial1.map = this.alphaMaskTexture1
        this.alphaMaskMaterial1.needsUpdate = true
        this.alphaMaskPlane1.scale.set(aspect, 1, 1)

        this.alphaMaskAnim1 = new SpriteSheet(alphaMaskImage, frameWidth, frameHeight, {
          frameCount,
          framesPerRow,
        })

        this.update(0)
      })
      .catch((error) => {
        console.error(error)
      })
  }

  private updateVisibility(): void {
    this.plane.visible = this.mask0Enabled
    this.alphaMaskPlane.visible = this.mask0Enabled
    this.plane1.visible = this.mask1Enabled
    this.alphaMaskPlane1.visible = this.mask1Enabled
  }

  private positionSecondaryMaskPlanes(): void {
    // Match distance to the primary plane, but rotate 90 degrees around the camera (yaw).
    const camPos = this.camera.position
    const v0 = new THREE.Vector3().subVectors(this.plane.position, camPos) // camera -> plane0
    const v1 = v0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2) // camera-right

    this.plane1.position.copy(camPos).add(v1)

    const toCam = new THREE.Vector3().subVectors(camPos, this.plane1.position)
    if (toCam.lengthSq() > 0) {
      toCam.normalize()
      this.plane1.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toCam)
    }

    this.alphaMaskPlane1.position.copy(this.plane1.position)
    this.alphaMaskPlane1.quaternion.copy(this.plane1.quaternion)
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
