// Keep one group's whole voice reply contiguous across administrator/user model queues.
export function createVoiceTurnQueue(){
  const queues=new Map()
  return {run(key,work,signal){const previous=queues.get(String(key))??Promise.resolve();const job=previous.catch(()=>{}).then(()=>{signal?.throwIfAborted();return work()});const tail=job.catch(()=>{});queues.set(String(key),tail);tail.finally(()=>{if(queues.get(String(key))===tail)queues.delete(String(key))});return job},size:()=>queues.size}
}
