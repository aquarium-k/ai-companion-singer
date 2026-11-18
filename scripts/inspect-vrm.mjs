/**
 * 检查 VRM 文件里我们依赖的东西是否齐全：
 * 骨骼、表情、lookAt、版本。
 *
 * 用法: node scripts/inspect-vrm.mjs models/text.vrm
 */
import fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/inspect-vrm.mjs <file.vrm>')
  process.exit(1)
}

const buf = fs.readFileSync(file)
const magic = buf.subarray(0, 4).toString('ascii')
if (magic !== 'glTF') {
  console.error(`不是 GLB 文件（magic=${magic}）`)
  process.exit(1)
}

const jsonLength = buf.readUInt32LE(12)
const jsonChunk = buf.subarray(20, 20 + jsonLength).toString('utf8')
const gltf = JSON.parse(jsonChunk)

const ext = gltf.extensions ?? {}
const isVrm1 = Boolean(ext.VRMC_vrm)
const isVrm0 = Boolean(ext.VRM)

console.log(`文件        ${file}`)
console.log(`glTF 版本   ${gltf.asset?.version}`)
console.log(`生成器      ${gltf.asset?.generator ?? '-'}`)
console.log(`VRM 版本    ${isVrm1 ? '1.0' : isVrm0 ? '0.x' : '未知'}`)

if (isVrm1) {
  const meta = ext.VRMC_vrm.meta ?? {}
  console.log(`模型名      ${meta.name ?? '-'}`)
  console.log(`作者        ${(meta.authors ?? []).join(', ') || '-'}`)
  console.log(`许可        ${JSON.stringify(meta.licenseUrl ?? '-')}`)
  console.log(`商用        ${meta.avatarPermission ?? meta.commercialUsage ?? '-'}`)
} else if (isVrm0) {
  const meta = ext.VRM.meta ?? {}
  console.log(`模型名      ${meta.title ?? '-'}`)
  console.log(`作者        ${meta.author ?? '-'}`)
  console.log(`商用        ${meta.licenseName ?? '-'} / ${meta.commercialUssageName ?? '-'}`)
}

// humanoid bones
const humanBones = ext.VRMC_vrm?.humanoid?.humanBones ?? ext.VRM?.humanoid?.humanBones ?? {}
const boneNames = Object.keys(humanBones)
console.log(`\n骨骼数量    ${boneNames.length}`)
const required = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
]
const missing = required.filter((b) => !boneNames.includes(b))
console.log(`必需骨缺失  ${missing.length ? missing.join(', ') : '无'}`)
console.log(`全部骨骼    ${boneNames.join(', ')}`)

// expressions
const preset =
  ext.VRMC_vrm?.expressions?.preset ??
  ext.VRM?.blendShapeMaster?.blendShapeGroups?.reduce((acc, g) => {
    acc[g.presetName] = true
    return acc
  }, {}) ??
  {}
const presetNames = Object.keys(preset)
console.log(`\n表情数量    ${presetNames.length}`)
console.log(`全部表情    ${presetNames.join(', ')}`)

const needExpr = ['blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised']
const missingExpr = needExpr.filter((e) => !presetNames.includes(e))
console.log(`缺失表情    ${missingExpr.length ? missingExpr.join(', ') : '无'}`)

// lookAt
const lookAt = ext.VRMC_vrm?.lookAt ?? ext.VRM?.firstPerson
console.log(`\nlookAt      ${lookAt ? (ext.VRMC_vrm?.lookAt?.type ?? 'VRM0 firstPerson') : '无'}`)
console.log(`网格数量    ${gltf.meshes?.length ?? 0}`)
console.log(`节点数量    ${gltf.nodes?.length ?? 0}`)
console.log(`材质数量    ${gltf.materials?.length ?? 0}`)
console.log(`贴图数量    ${gltf.textures?.length ?? 0}`)
