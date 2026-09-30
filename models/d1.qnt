// One D1 primary, one lagging read replica, one logical client session.
module d1 {
  var primaryVersion: int
  var replicaVersion: int
  var bookmark: int
  var readVersion: int // -1 means no read yet
  var phase: int // 0 before write, 1 write acknowledged, 2 read complete

  action init = all {
    primaryVersion' = 0,
    replicaVersion' = 0,
    bookmark' = 0,
    readVersion' = -1,
    phase' = 0,
  }

  action write = all {
    phase == 0,
    primaryVersion' = 1,
    bookmark' = 1,
    phase' = 1,
    replicaVersion' = replicaVersion,
    readVersion' = readVersion,
  }

  action replicate = all {
    replicaVersion < primaryVersion,
    replicaVersion' = primaryVersion,
    primaryVersion' = primaryVersion,
    bookmark' = bookmark,
    readVersion' = readVersion,
    phase' = phase,
  }

  // Bug: a new unconstrained read can reach a lagging replica.
  action readNaive = all {
    phase == 1,
    readVersion' = replicaVersion,
    phase' = 2,
    primaryVersion' = primaryVersion,
    replicaVersion' = replicaVersion,
    bookmark' = bookmark,
  }

  // A D1 Session carrying the bookmark waits until the replica catches up.
  action readWithBookmark = all {
    phase == 1,
    replicaVersion >= bookmark,
    readVersion' = replicaVersion,
    phase' = 2,
    primaryVersion' = primaryVersion,
    replicaVersion' = replicaVersion,
    bookmark' = bookmark,
  }

  action stepNaive = any { write, replicate, readNaive }
  action stepSafe = any { write, replicate, readWithBookmark }

  val readMyWrites = if (readVersion == -1) true else readVersion >= bookmark
}
