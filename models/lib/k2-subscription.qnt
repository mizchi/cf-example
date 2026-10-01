// One subscription reading a single two-record batch, within retention.
// Batch IDs are lease generations, not stable IDs for application events.
// Two ticks abstract the five-minute lease. MaxBatches bounds exploration.
// Source: https://developers.cloudflare.com/k2/features/consume/
module k2Subscription {
  const MaxBatches: int
  assume PositiveBound = MaxBatches > 0

  var batchId: int
  var holder: int // 0: no active lease; 1/2: worker ID
  var remaining: int
  var cursor: int // 0: unacknowledged; 2: whole batch acknowledged

  action init = all {
    batchId' = 0,
    holder' = 0,
    remaining' = 0,
    cursor' = 0,
  }

  action hold = all {
    batchId' = batchId,
    holder' = holder,
    remaining' = remaining,
    cursor' = cursor,
  }

  action acquire(worker: int): bool = all {
    worker.in(Set(1, 2)),
    holder == 0,
    cursor == 0,
    batchId < MaxBatches,
    batchId' = batchId + 1,
    holder' = worker,
    remaining' = 2,
    cursor' = cursor,
  }

  // Repeated consume by the current worker returns the same batch and
  // refreshes its lease, even if the original response was lost.
  action recover(worker: int): bool = all {
    holder == worker,
    remaining > 0,
    batchId' = batchId,
    holder' = holder,
    remaining' = 2,
    cursor' = cursor,
  }

  action extend(worker: int, batch: int): bool = all {
    batch == batchId,
    recover(worker),
  }

  action tick = all {
    remaining > 0,
    remaining' = remaining - 1,
    holder' = if (remaining == 1) 0 else holder,
    batchId' = batchId,
    cursor' = cursor,
  }

  // Only the current batch ID advances this subscription. Acknowledging
  // an old/unknown/already acknowledged batch succeeds without progress.
  // After expiry but before redelivery, allow ack to succeed: the docs only
  // explicitly guarantee a no-op after records have been leased again.
  action ack(batch: int): bool = any {
    all {
      batch > 0,
      batch == batchId,
      cursor == 0,
      cursor' = 2,
      holder' = 0,
      remaining' = 0,
      batchId' = batchId,
    },
    all { batch == 0 or batch != batchId or cursor == 2, hold },
  }

  action nack(batch: int): bool = any {
    all {
      batch > 0,
      batch == batchId,
      cursor == 0,
      holder' = 0,
      remaining' = 0,
      batchId' = batchId,
      cursor' = cursor,
    },
    all { batch == 0 or batch != batchId or cursor == 2, hold },
  }

  val wellFormed = all {
    batchId >= 0 and batchId <= MaxBatches,
    holder.in(Set(0, 1, 2)),
    remaining.in(Set(0, 1, 2)),
    (holder == 0) == (remaining == 0),
    cursor.in(Set(0, 2)),
    cursor == 0 or holder == 0,
    batchId > 0 or (cursor == 0 and holder == 0),
  }
}
