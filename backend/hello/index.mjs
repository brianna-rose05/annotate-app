export const handler = async (e) => {
    return {
        statusCode: 200,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message: "hello from Lambda!"})
    }
}