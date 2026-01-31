import * as THREE from 'three'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'

let initialized = false

export function initThreeMeshBVH(): void {
  if (initialized) return
  initialized = true

  ;(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
  ;(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
  ;(THREE.Mesh.prototype as any).raycast = acceleratedRaycast
}

export function setRaycasterFirstHitOnly(raycaster: THREE.Raycaster, firstHitOnly: boolean): void {
  ;(raycaster as any).firstHitOnly = firstHitOnly
}

export function computeBoundsTreeOnce(geometry: THREE.BufferGeometry): void {
  initThreeMeshBVH()
  const g = geometry as any
  if (g.boundsTree) return
  if (typeof g.computeBoundsTree === 'function') g.computeBoundsTree()
}

export function disposeBoundsTreeIfPresent(geometry: THREE.BufferGeometry): void {
  const g = geometry as any
  if (!g.boundsTree) return
  if (typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree()
}
