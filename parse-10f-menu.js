const { GoogleGenAI } = require('@google/genai')
const fs = require('fs')
const path = require('path')

function cleanMenuItems(items) {
    if (!Array.isArray(items)) {
        return []
    }

    return items
        .map(item =>
            String(item)
                .replace(/^[&＆]\s*/g, '')
                .trim()
        )
        .filter(item => item.length > 0)
}

function getMimeType(imagePath) {
    const extension = path.extname(imagePath).toLowerCase()

    switch (extension) {
        case '.png':
            return 'image/png'
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg'
        case '.webp':
            return 'image/webp'
        default:
            throw new Error(`Unsupported image format: ${extension}`)
    }
}

function extractJson(content) {
    if (!content || typeof content !== 'string') {
        throw new Error('Gemini response is empty')
    }

    const trimmed = content.trim()

    // 정상적인 JSON 응답
    try {
        return JSON.parse(trimmed)
    } catch {
        // 마크다운 코드 블록이 포함된 경우
    }

    const codeBlockMatch = trimmed.match(
        /```(?:json)?\s*([\s\S]*?)\s*```/i
    )

    if (codeBlockMatch) {
        return JSON.parse(codeBlockMatch[1])
    }

    // 응답에 설명이 섞인 경우 마지막 수단
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/)

    if (!jsonMatch) {
        throw new Error('Failed to extract JSON from Gemini response')
    }

    return JSON.parse(jsonMatch[0])
}

function validateMenuData(menuData) {
    if (!menuData || typeof menuData !== 'object') {
        throw new Error('Invalid menu data')
    }

    if (
        typeof menuData.weekInfo !== 'string' ||
        menuData.weekInfo.trim().length === 0
    ) {
        throw new Error('weekInfo is missing')
    }

    if (!Array.isArray(menuData.days) || menuData.days.length === 0) {
        throw new Error('days is missing or empty')
    }

    for (const day of menuData.days) {
        if (!day.dayOfWeek || !day.date) {
            throw new Error(
                `Invalid day data: ${JSON.stringify(day)}`
            )
        }

        if (!day.meals || typeof day.meals !== 'object') {
            day.meals = {}
        }

        for (const course of ['도시락', '브런치', '샐러드']) {
            if (!Array.isArray(day.meals[course])) {
                day.meals[course] = []
            }
        }
    }

    return menuData
}

async function parseMenuImage(imagePath) {
    const apiKey = process.env.GEMINI_API_KEY

    if (!apiKey) {
        throw new Error(
            'GEMINI_API_KEY environment variable is not set'
        )
    }

    const ai = new GoogleGenAI({
        apiKey
    })

    const modelName =
        process.env.GEMINI_MODEL || 'gemini-3.5-flash'

    console.log(`Parsing image: ${imagePath}`)
    console.log(`Using model: ${modelName}`)

    try {
        const imageBuffer = fs.readFileSync(imagePath)
        const base64Image = imageBuffer.toString('base64')
        const mimeType = getMimeType(imagePath)

        const prompt = `이 이미지는 멀티캠퍼스 10층 식당의 주간 식단표입니다.

이미지를 분석해서 각 요일(월요일~금요일)의 식단을 JSON 형식으로 정리해주세요.

중요 사항:
- 날짜는 이미지에 표시된 실제 날짜를 그대로 사용하세요.
- 날짜 형식은 "1.6", "7.27"처럼 월과 일을 점으로 구분하세요.
- 존재하지 않는 메뉴를 임의로 만들지 마세요.
- 메뉴가 없는 항목은 빈 배열로 반환하세요.
- 이미지에 보이는 메뉴 이름을 가능한 한 정확히 옮겨 적으세요.
- JSON 이외의 설명이나 마크다운은 출력하지 마세요.

반환 형식:
{
  "weekInfo": "26년 1월 2주차",
  "days": [
    {
      "dayOfWeek": "월요일",
      "date": "1.6",
      "meals": {
        "도시락": ["메뉴1", "메뉴2"],
        "브런치": ["메뉴1", "메뉴2"],
        "샐러드": ["메뉴1", "메뉴2"]
      }
    }
  ]
}`

        console.log('Sending image to Gemini...')

        const response = await ai.models.generateContent({
            model: modelName,
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: prompt
                        },
                        {
                            inlineData: {
                                data: base64Image,
                                mimeType
                            }
                        }
                    ]
                }
            ],
            config: {
                responseMimeType: 'application/json',
                temperature: 0.1
            }
        })

        const content = response.text

        if (!content) {
            throw new Error('Gemini returned an empty response')
        }

        console.log('Gemini Response:')
        console.log(content)
        console.log('\n---\n')

        const menuData = extractJson(content)
        return validateMenuData(menuData)
    } catch (error) {
        console.error(
            'Error parsing image:',
            error?.message || error
        )
        throw error
    }
}

function parseDateValue(dateValue) {
    const normalized = String(dateValue)
        .trim()
        .replace(/월/g, '.')
        .replace(/일/g, '')
        .replace(/\s+/g, '')

    const match = normalized.match(/^(\d{1,2})\.(\d{1,2})\.?$/)

    if (!match) {
        throw new Error(`Invalid date format: ${dateValue}`)
    }

    const month = Number(match[1])
    const day = Number(match[2])

    if (
        !Number.isInteger(month) ||
        !Number.isInteger(day) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
    ) {
        throw new Error(`Invalid date value: ${dateValue}`)
    }

    return {
        month,
        day
    }
}

function convertToDateBasedJSON(menuData) {
    const weekPattern = /(\d{2,4})년\s*(\d{1,2})월/
    const match = menuData.weekInfo.match(weekPattern)

    if (!match) {
        throw new Error(
            `Failed to parse week info: ${menuData.weekInfo}`
        )
    }

    const parsedYear = Number(match[1])
    const year =
        parsedYear < 100 ? 2000 + parsedYear : parsedYear

    console.log(`Week info: ${menuData.weekInfo}`)
    console.log(`Parsed year: ${year}`)

    const result = []

    for (const day of menuData.days) {
        const {
            month: dateMonth,
            day: dateDay
        } = parseDateValue(day.date)

        const dateStr =
            `${year}-` +
            `${String(dateMonth).padStart(2, '0')}-` +
            `${String(dateDay).padStart(2, '0')}`

        console.log(
            `${day.dayOfWeek}: ${day.date} -> ${dateStr}`
        )

        const meals = []

        for (const courseName of [
            '도시락',
            '브런치',
            '샐러드'
        ]) {
            const items = cleanMenuItems(
                day.meals?.[courseName] || []
            )

            if (items.length === 0) {
                continue
            }

            meals.push({
                name: items.join(', '),
                courseName,
                setName: '10층 공존식단',
                items
            })
        }

        result.push({
            date: dateStr,
            dayOfWeek: day.dayOfWeek,
            restaurant: '멀티캠퍼스 10층',
            mealTime: '점심',
            meals,
            updatedAt: new Date().toISOString()
        })
    }

    return result
}

async function main() {
    const imagePath = process.argv[2]

    if (!imagePath) {
        console.error(
            'Usage: node parse-10f-menu.js <image-path>'
        )
        process.exit(1)
    }

    if (!fs.existsSync(imagePath)) {
        console.error(`Image not found: ${imagePath}`)
        process.exit(1)
    }

    if (!process.env.GEMINI_API_KEY) {
        console.error(
            'Error: GEMINI_API_KEY environment variable is not set'
        )
        process.exit(1)
    }

    try {
        const menuData = await parseMenuImage(imagePath)

        const dateBasedMenus =
            convertToDateBasedJSON(menuData)

        const dataDir = path.join(__dirname, 'data-10f')

        fs.mkdirSync(dataDir, {
            recursive: true
        })

        for (const dayMenu of dateBasedMenus) {
            const filePath = path.join(
                dataDir,
                `${dayMenu.date}.json`
            )

            fs.writeFileSync(
                filePath,
                JSON.stringify(dayMenu, null, 2),
                'utf-8'
            )

            console.log(`✓ Saved to ${filePath}`)
        }

        console.log('\n✓ All done!')
    } catch (error) {
        console.error(
            'Error:',
            error?.message || error
        )
        process.exit(1)
    }
}

main()
