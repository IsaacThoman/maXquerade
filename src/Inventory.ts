export type ItemId = number

export class Inventory {
  private readonly items = new Set<ItemId>()

  has(id: ItemId): boolean {
    return this.items.has(id)
  }

  add(id: ItemId): void {
    this.items.add(id)
  }

  remove(id: ItemId): void {
    this.items.delete(id)
  }

  clear(): void {
    this.items.clear()
  }
}
